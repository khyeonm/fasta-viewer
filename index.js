// AutoPipe Plugin: fasta-viewer
// Sequence viewer with colored nucleotides and GC content

(function() {
  // ── Inlined plain-gzip reader ──
// Shared plain-gzip streaming line reader for AutoPipe text viewers.
//
// Unlike BGZF (vcf.gz/bed.gz), a .fastq.gz / .fasta.gz / .csv.gz is a single
// gzip stream with no block index — you cannot jump to an arbitrary offset,
// only read forward. That is fine for a viewer: fetch the file as a stream,
// pipe it through DecompressionStream, and stop once a page is filled. Only
// the leading bytes are ever downloaded, so a multi-GB fastq.gz never lands
// in memory whole.
//
// Exposes window.AutoPipeGz = { available, lineReader(fileUrl) -> { readLines(n) } }.
// Sequential paging only: going back to page 0 reopens the stream from the top.

(function () {
  if (window.AutoPipeGz) return;

  function lineReader(fileUrl) {
    var st = { reader: null, tail: '', eof: false, decoder: new TextDecoder(), done: false };

    function open() {
      return fetch(fileUrl).then(function (resp) {
        if (!resp.ok || !resp.body) throw new Error('fetch failed: ' + resp.status);
        var stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
        st.reader = stream.getReader();
      });
    }

    function pump() {
      if (!st.reader) return open().then(pump);
      return st.reader.read().then(function (r) {
        if (r.done) { st.eof = true; return false; }
        st.tail += st.decoder.decode(r.value, { stream: true });
        return true;
      });
    }

    // Read up to `n` complete lines; fewer means end of stream.
    function readLines(n) {
      var out = [];
      function step() {
        var nl;
        while (out.length < n && (nl = st.tail.indexOf('\n')) >= 0) {
          out.push(st.tail.slice(0, nl));
          st.tail = st.tail.slice(nl + 1);
        }
        if (out.length >= n) return Promise.resolve(out);
        if (st.eof) {
          if (st.tail.length) { out.push(st.tail); st.tail = ''; }
          return Promise.resolve(out);
        }
        return pump().then(step);
      }
      return step();
    }

    // Release the underlying network stream when the reader is discarded.
    function cancel() {
      if (st.reader) { try { st.reader.cancel(); } catch (e) { /* already closed */ } }
    }

    return { readLines: readLines, cancel: cancel, state: st };
  }

  window.AutoPipeGz = {
    available: typeof DecompressionStream !== 'undefined',
    lineReader: lineReader
  };
})();


  // Lines per page. FASTA is streamed by LINE, not by record, so a single
  // huge contig (a chromosome) is spread over many pages instead of being
  // pulled into memory whole. A page holds either many short sequences or a
  // slice of one long one.
  var PAGE_SIZE = 400;
  var allSeqs = [];
  var filteredSeqs = [];
  var currentPage = 0;
  var filterText = '';
  var expandedIdx = {};
  var rootEl = null;

  // Parse one page's worth of lines into sequence fragments. If the first data
  // line is not a ">" header, this page begins in the MIDDLE of a sequence that
  // started on an earlier page — that fragment is flagged `continued` so the UI
  // can label it. `header` is null for such a lead-in fragment.
  function parsePage(lines) {
    var seqs = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = String(lines[i]).trim();
      if (!l) continue;
      if (l[0] === '>') {
        if (cur) seqs.push(cur);
        cur = { header: l.substring(1).trim(), seq: '', continued: false };
      } else {
        if (!cur) cur = { header: null, seq: '', continued: true };
        cur.seq += l.toUpperCase();
      }
    }
    if (cur) seqs.push(cur);
    return seqs;
  }

  function gcContent(seq) {
    if (!seq.length) return 0;
    var gc = 0;
    for (var i = 0; i < seq.length; i++) {
      if (seq[i] === 'G' || seq[i] === 'C') gc++;
    }
    return (gc / seq.length * 100).toFixed(1);
  }

  function detectType(seqs) {
    var sample = '';
    for (var i = 0; i < Math.min(seqs.length, 5); i++) {
      sample += seqs[i].seq.substring(0, 200);
    }
    if (!sample) return 'Unknown';
    var hasU = sample.indexOf('U') >= 0;
    var dnaChars = 0;
    for (var i = 0; i < sample.length; i++) {
      if ('ATGCNU'.indexOf(sample[i]) >= 0) dnaChars++;
    }
    if (dnaChars / sample.length > 0.9) return hasU ? 'RNA' : 'DNA';
    return 'Protein';
  }

  function formatNum(n) { return n.toLocaleString(); }

  function colorBases(seq, maxLen) {
    // A page caps how much sequence lands here, so render the whole fragment.
    var s = maxLen ? seq.substring(0, maxLen) : seq;
    var html = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if ('ATUGCN'.indexOf(ch) >= 0) {
        html += '<span class="base-' + ch + '">' + ch + '</span>';
      } else {
        html += ch;
      }
    }
    return html;
  }

  function applyFilter() {
    var ft = filterText.toLowerCase();
    filteredSeqs = [];
    for (var i = 0; i < allSeqs.length; i++) {
      var hdr = allSeqs[i].header || '';
      if (!ft || hdr.toLowerCase().indexOf(ft) >= 0) {
        filteredSeqs.push({ idx: i, data: allSeqs[i] });
      }
    }
  }

  function _loadPage(page) {
    var target = (rootEl && rootEl.querySelector('#__plugin_content__')) || rootEl;
    if (!target) return;

    _fetchPage(_currentFilename, page).then(function(data) {
      if (data.error) {
        target.innerHTML = '<p style="color:red;padding:16px;">Error: ' + data.error + '</p>';
        return;
      }
      _totalLines = data.total || _totalLines;
      currentPage = page;
      var lines = [];
      if (data.rows) {
        for (var i = 0; i < data.rows.length; i++) {
          var row = data.rows[i];
          lines.push(Array.isArray(row) ? row.join('\t') : row);
        }
      }
      allSeqs = parsePage(lines);
      expandedIdx = {};
      applyFilter();
      render();
    }).catch(function(err) {
      target.innerHTML = '<p style="color:red;padding:16px;">Error: ' + err.message + '</p>';
    });
  }

  function render() {
    var target = (rootEl && rootEl.querySelector('#__plugin_content__')) || rootEl;
    if (!target) return;
    var seqType = detectType(allSeqs);
    var totalBases = 0;
    var totalGC = 0;
    for (var i = 0; i < allSeqs.length; i++) {
      totalBases += allSeqs[i].seq.length;
      totalGC += parseFloat(gcContent(allSeqs[i].seq)) * allSeqs[i].seq.length / 100;
    }
    var avgGC = totalBases > 0 ? (totalGC / totalBases * 100).toFixed(1) : '0.0';

    var totalPages = Math.max(1, Math.ceil(_totalLines / PAGE_SIZE));
    var lastPage = currentPage >= totalPages - 1;

    // How many real records (">" headers) start on this page.
    var recCount = 0;
    for (var i = 0; i < allSeqs.length; i++) { if (!allSeqs[i].continued) recCount++; }

    var html = '<div class="fasta-plugin">';

    // Summary \u2014 per page, since a sequential stream has no whole-file totals.
    html += '<div class="fasta-summary">';
    html += '<span class="stat"><b>' + formatNum(recCount) + '</b> sequences (this page)</span>';
    html += '<span class="stat"><b>' + formatNum(totalBases) + '</b> bases (this page)</span>';
    html += '<span class="stat">Type: <b>' + seqType + '</b></span>';
    if (seqType !== 'Protein') html += '<span class="stat">Avg GC: <b>' + avgGC + '%</b></span>';
    html += '</div>';

    // Sequence list
    html += '<div class="fasta-list">';
    for (var si = 0; si < filteredSeqs.length; si++) {
      var entry = filteredSeqs[si];
      var globalIdx = entry.idx;
      var seq = entry.data;
      // A lead-in fragment (continued from the previous page) and a lone
      // sequence open by default; multiple short records stay collapsed.
      var autoOpen = seq.continued || filteredSeqs.length === 1;
      var isOpen = (globalIdx in expandedIdx) ? expandedIdx[globalIdx] : autoOpen;
      // The last fragment on a non-final page runs on into the next page.
      var isLast = si === filteredSeqs.length - 1;
      var runsOn = isLast && !lastPage && !filterText;

      html += '<div class="fasta-entry">';
      html += '<div class="fasta-header" data-idx="' + globalIdx + '" data-auto="' + (autoOpen ? '1' : '0') + '">';
      var name = seq.continued
        ? '\u21B3 (continued from previous page)'
        : _escapeHtml(seq.header || '(unnamed)');
      html += '<span class="fasta-header-name">' + (isOpen ? '\u25BC ' : '\u25B6 ') + name + '</span>';
      html += '<span class="fasta-header-meta">';
      html += '<span>' + formatNum(seq.seq.length) + ' bp' +
        ((seq.continued || runsOn) ? ' (partial)' : '') + '</span>';
      if (seqType !== 'Protein') html += '<span class="gc-badge">GC ' + gcContent(seq.seq) + '%</span>';
      html += '</span>';
      html += '</div>';

      if (isOpen) {
        html += '<div class="fasta-seq">' + colorBases(seq.seq) +
          (runsOn ? '<span class="fasta-cont">\u2026 continues on next page</span>' : '') +
          '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Pagination
    if (totalPages > 1) {
      html += '<div class="fasta-pagination">';
      html += '<button data-page="prev"' + (currentPage <= 0 ? ' disabled' : '') + '>&laquo; Prev</button>';
      var startP = Math.max(0, currentPage - 3);
      var endP = Math.min(totalPages, startP + 7);
      if (startP > 0) html += '<button data-page="0">1</button><span>...</span>';
      for (var p = startP; p < endP; p++) {
        html += '<button data-page="' + p + '"' + (p === currentPage ? ' class="current"' : '') + '>' + (p + 1) + '</button>';
      }
      if (endP < totalPages) html += '<span>...</span><button data-page="' + (totalPages - 1) + '">' + totalPages + '</button>';
      html += '<button data-page="next"' + (currentPage >= totalPages - 1 ? ' disabled' : '') + '>Next &raquo;</button>';
      html += '<span class="page-info">Page ' + (currentPage + 1) + ' of ' + totalPages + '</span>';
      html += '</div>';
    }

    html += '</div>';
    target.innerHTML = html;

    // Events
    var hdrs = target.querySelectorAll('.fasta-header');
    for (var i = 0; i < hdrs.length; i++) {
      hdrs[i].addEventListener('click', function() {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        var auto = this.getAttribute('data-auto') === '1';
        var cur = (idx in expandedIdx) ? expandedIdx[idx] : auto;
        expandedIdx[idx] = !cur;
        render();
      });
    }
    var pbs = target.querySelectorAll('.fasta-pagination button');
    for (var i = 0; i < pbs.length; i++) {
      pbs[i].addEventListener('click', function() {
        var pg = this.getAttribute('data-page');
        if (pg === 'prev') { if (currentPage > 0) _loadPage(currentPage - 1); }
        else if (pg === 'next') { if (currentPage < totalPages - 1) _loadPage(currentPage + 1); }
        else { _loadPage(parseInt(pg, 10)); }
      });
    }
  }

  // ── IGV.js integration ──
  var KNOWN_GENOMES = [
    {id:'hg38', label:'Human (GRCh38/hg38)'},
    {id:'hg19', label:'Human (GRCh37/hg19)'},
    {id:'mm39', label:'Mouse (GRCm39/mm39)'},
    {id:'mm10', label:'Mouse (GRCm38/mm10)'},
    {id:'rn7',  label:'Rat (mRatBN7.2/rn7)'},
    {id:'rn6',  label:'Rat (Rnor_6.0/rn6)'},
    {id:'dm6',  label:'Fruit fly (BDGP6/dm6)'},
    {id:'ce11', label:'C. elegans (WBcel235/ce11)'},
    {id:'danRer11', label:'Zebrafish (GRCz11/danRer11)'},
    {id:'sacCer3',  label:'Yeast (sacCer3)'},
    {id:'tair10',   label:'Arabidopsis (TAIR10)'},
    {id:'galGal6',  label:'Chicken (GRCg6a/galGal6)'}
  ];
  var _igvRef = null;
  var _igvMode = 'data';
  var _selectedGenome = null;
  var _igvBrowser = null;

  // igv.js sequence tracks only draw at 10 bp/pixel or finer, so the opening
  // window has to stay narrow enough to clear that on a modest pane width.
  var IGV_WINDOW = 5000;

  function _escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // The reference arrives either as a genome ID, a bare filename, or a full
  // path (show_results passes whatever the caller supplied). /file/ is keyed by
  // filename alone, so strip any directory part.
  function _refUrl(ref) {
    var base = String(ref).replace(/\\/g, '/').split('/').pop();
    return '/file/' + encodeURIComponent(base);
  }

  function _disposeIgvBrowser() {
    if (_igvBrowser) {
      // The host never calls destroy(), and igv.js keeps every browser it
      // creates in a module-level list. Without this, each tab switch leaks a
      // browser plus its listeners and caches.
      try { igv.removeBrowser(_igvBrowser); } catch (e) { /* already detached */ }
      _igvBrowser = null;
    }
  }

  // A 1-byte ranged GET is used rather than HEAD so this works on any server
  // that serves /file/.
  function _probeUrl(url) {
    return fetch(url, { headers: { Range: 'bytes=0-0' } })
      .then(function(r) { return r.ok ? url : null; })
      .catch(function() { return null; });
  }

  function _findIndex(fileUrl, exts) {
    var candidates = [];
    for (var i = 0; i < exts.length; i++) {
      candidates.push(fileUrl + '.' + exts[i]);
      candidates.push(fileUrl.replace(/\.[^.\/]+$/, '.' + exts[i]));
    }
    return candidates.reduce(function(chain, url) {
      return chain.then(function(found) { return found || _probeUrl(url); });
    }, Promise.resolve(null));
  }

  // Without an explicit locus igv.js opens at the whole first chromosome, or
  // the whole genome when the reference has several contigs — either way the
  // sequence track is far past its 10 bp/pixel limit and draws nothing. Open
  // on the head of this file's first record instead.
  function _resolveLocus(filename) {
    return fetch('/data/' + encodeURIComponent(filename) + '?page=0&page_size=5')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var rows = (d && d.rows) || [];
        for (var i = 0; i < rows.length; i++) {
          var line = rows[i] && rows[i][0];
          if (line && line.charAt(0) === '>') {
            // ">chr1 dna:chromosome ..." — the contig name is the first token.
            var name = line.substring(1).split(/\s+/)[0];
            if (name) return name + ':1-' + IGV_WINDOW;
          }
        }
        return null;
      })
      .catch(function() { return null; });
  }

  function _fetchReference() {
    return fetch('/api/reference').then(function(r) { return r.json(); })
      .then(function(d) { _igvRef = d.reference || null; })
      .catch(function() { _igvRef = null; });
  }

  // igv.js ships inside the plugin so the viewer works on machines with no
  // internet access. The CDN stays as a fallback for installs that predate the
  // bundled copy.
  var IGV_LOCAL = '/plugin/fasta-viewer/igv.min.js';
  var IGV_CDN = 'https://cdn.jsdelivr.net/npm/igv@3/dist/igv.min.js';

  function _loadIgvJs() {
    if (window.igv) return Promise.resolve();
    function load(src) {
      return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = function() { resolve(); };
        s.onerror = function() { reject(new Error('Failed to load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return load(IGV_LOCAL).catch(function() { return load(IGV_CDN); });
  }

  function _buildGenomeDropdown() {
    var current = _selectedGenome || _igvRef || '';
    var refLabel = _igvRef ? String(_igvRef).replace(/\\/g, '/').split('/').pop() : '';
    var html = '<span style="font-size:12px;color:#888;font-weight:500;margin-right:4px">Reference:</span>';
    html += '<select id="__igv_genome_select__" style="font-size:12px;padding:4px 8px;max-width:220px;border:1px solid #ddd;border-radius:4px">';
    html += '<option value="' + _escapeHtml(_igvRef || '') + '"' + (current === _igvRef ? ' selected' : '') + '>' + _escapeHtml(refLabel || 'none') + '</option>';
    KNOWN_GENOMES.forEach(function(g) {
      if (g.id !== _igvRef) {
        html += '<option value="' + g.id + '"' + (current === g.id ? ' selected' : '') + '>' + g.label + '</option>';
      }
    });
    html += '</select>';
    return html;
  }

  function _renderIgv(container, fileUrl, filename, trackType, trackFormat) {
    _disposeIgvBrowser();
    container.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'ap-loading';
    div.textContent = 'Loading...';
    container.appendChild(div);

    var activeRef = _selectedGenome || _igvRef;
    var knownIds = KNOWN_GENOMES.map(function(g) { return g.id; });
    var isKnownGenome = knownIds.indexOf(activeRef) >= 0;

    return Promise.all([
      _loadIgvJs(),
      _resolveLocus(filename),
      isKnownGenome ? Promise.resolve(null) : _findIndex(_refUrl(activeRef), ['fai'])
    ]).then(function(results) {
      var locus = results[1], refIndex = results[2];
      // The user may have switched tabs while the probes were in flight.
      if (!div.isConnected) return;
      div.textContent = '';
      div.className = '';

      var opts = {};
      if (isKnownGenome) {
        opts.genome = activeRef;
      } else {
        opts.reference = { fastaURL: _refUrl(activeRef) };
        if (refIndex) {
          // Indexed means igv.js range-reads the FASTA instead of pulling the
          // whole file into memory — the difference between a few KB and the
          // entire reference.
          opts.reference.indexURL = refIndex;
          opts.reference.indexed = true;
        } else {
          opts.reference.indexed = false;
        }
      }
      if (locus) opts.locus = locus;
      opts.tracks = [{ type: trackType, format: trackFormat, url: fileUrl, name: filename }];

      // Returned, not fire-and-forget: a rejected createBrowser used to become
      // an unhandled rejection and leave a blank pane with no explanation.
      return igv.createBrowser(div, opts).then(function(browser) {
        _igvBrowser = browser;
      });
    }).catch(function(e) {
      container.innerHTML = '<div style="color:red;padding:16px;">IGV Error: ' +
        _escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
    });
  }

  var TRACK_TYPE = 'sequence';
  var TRACK_FORMAT = 'fasta';

  var _totalLines = 0;
  var _currentFilename = '';

  function _isGz(name) { return /\.gz$/i.test(name); }

  var _gzCur = null;
  var _savedFileUrl = '';

  // A .fasta.gz is a single gzip stream: read it forward in the browser so no
  // server tool is needed and only the leading bytes download. Sequential
  // paging only (no random seek); plain files keep using /data/.
  function _fetchPage(filename, page) {
    if (_isGz(filename) && window.AutoPipeGz && window.AutoPipeGz.available) {
      return _fetchPageGz(filename, page).catch(function() {
        return _fetchPageServer(filename, page);
      });
    }
    return _fetchPageServer(filename, page);
  }

  function _fetchPageServer(filename, page) {
    return fetch('/data/' + encodeURIComponent(filename) + '?page=' + page + '&page_size=' + PAGE_SIZE)
      .then(function(resp) { return resp.json(); });
  }

  function _gzFileUrl(filename) {
    return (typeof _savedFileUrl !== 'undefined' && _savedFileUrl)
      ? _savedFileUrl : ('/file/' + encodeURIComponent(filename));
  }

  // Page by LINE so a huge single contig streams across pages instead of being
  // read whole. Matches the server's sed-based line paging, so gz and plain
  // files break at the same boundaries. Sequential only: reopen from the top
  // unless paging forward from the current cursor.
  function _fetchPageGz(filename, page) {
    var reuse = _gzCur && _gzCur.name === filename && _gzCur.page === page - 1 && !_gzCur.eof;
    if (!reuse) {
      if (_gzCur && _gzCur.rd) _gzCur.rd.cancel();
      _gzCur = { name: filename, page: -1, eof: false,
                 rd: window.AutoPipeGz.lineReader(_gzFileUrl(filename)) };
      var skip = page * PAGE_SIZE;
      var doSkip = function() {
        if (skip <= 0) return Promise.resolve();
        return _gzCur.rd.readLines(Math.min(skip, PAGE_SIZE)).then(function(ls) {
          if (!ls.length) { _gzCur.eof = true; return; }
          skip -= ls.length;
          return doSkip();
        });
      };
      return doSkip().then(function() { return _gzTake(page); });
    }
    return _gzTake(page);
  }

  function _gzTake(page) {
    return _gzCur.rd.readLines(PAGE_SIZE).then(function(lines) {
      _gzCur.page = page;
      if (lines.length < PAGE_SIZE) _gzCur.eof = true;
      // Sequential stream: true line count is unknown until EOF. Report lines
      // seen plus one more page's worth while data remains, so "Next" stays live.
      var hasMore = !_gzCur.eof;
      var total = page * PAGE_SIZE + lines.length + (hasMore ? 1 : 0);
      return { rows: lines, total: total, page: page, page_size: PAGE_SIZE };
    });
  }

  function _renderData(container, fileUrl, filename) {
    container.innerHTML = '<div class="ap-loading">Loading...</div>';
    allSeqs = []; filteredSeqs = []; currentPage = 0; filterText = ''; expandedIdx = {};
    _currentFilename = filename;

    _fetchPage(filename, 0).then(function(data) {
      if (data.error) {
        container.innerHTML = '<p style="color:red;padding:16px;">Error: ' + data.error + '</p>';
        return;
      }
      _totalLines = data.total || 0;
      var lines = [];
      if (data.rows) {
        for (var i = 0; i < data.rows.length; i++) {
          var row = data.rows[i];
          lines.push(Array.isArray(row) ? row.join('\t') : row);
        }
      }
      allSeqs = parsePage(lines);
      applyFilter();
      render();
    }).catch(function(err) {
      container.innerHTML = '<p style="color:red;padding:16px;">Error loading file: ' + err.message + '</p>';
    });
  }

  function _showView(container, fileUrl, filename) {
    // Every path through here replaces container.innerHTML, detaching any live
    // IGV browser — drop it before the DOM goes away.
    _disposeIgvBrowser();
    if (_igvRef) {
      var tabsHtml = '<div style="display:flex;gap:4px;margin-bottom:12px">';
      tabsHtml += '<button id="__tab_data__" style="padding:6px 16px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;' + (_igvMode === 'data' ? 'background:#007bff;color:white;border-color:#007bff' : 'background:#f8f8f8') + '">Data</button>';
      tabsHtml += '<button id="__tab_igv__" style="padding:6px 16px;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;' + (_igvMode === 'igv' ? 'background:#007bff;color:white;border-color:#007bff' : 'background:#f8f8f8') + '">IGV</button>';
      tabsHtml += '</div>';
      if (_igvMode === 'igv') tabsHtml += _buildGenomeDropdown();
      container.innerHTML = tabsHtml + '<div id="__plugin_content__"></div>';

      container.querySelector('#__tab_data__').onclick = function() { _igvMode = 'data'; _showView(container, fileUrl, filename); };
      container.querySelector('#__tab_igv__').onclick = function() { _igvMode = 'igv'; _showView(container, fileUrl, filename); };
      var genomeSelect = container.querySelector('#__igv_genome_select__');
      if (genomeSelect) genomeSelect.onchange = function() { _selectedGenome = this.value; _showView(container, fileUrl, filename); };

      var content = container.querySelector('#__plugin_content__');
      if (_igvMode === 'igv') {
        _renderIgv(content, fileUrl, filename, TRACK_TYPE, TRACK_FORMAT);
      } else {
        _renderData(content, fileUrl, filename);
      }
    } else {
      _renderData(container, fileUrl, filename);
    }
  }

  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      // The host caches the plugin instance and only ever calls render(), so
      // this is the one reliable teardown point between files.
      _disposeIgvBrowser();
      rootEl = container;
      _savedFileUrl = fileUrl; _gzCur = null;
      rootEl.innerHTML = '<div class="ap-loading">Loading...</div>';
      _igvMode = 'data';
      _selectedGenome = null;

      _fetchReference().then(function() {
        _showView(container, fileUrl, filename);
      });
    },
    destroy: function() { _disposeIgvBrowser(); allSeqs = []; filteredSeqs = []; rootEl = null; }
  };
})();
