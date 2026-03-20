// AutoPipe Plugin: fasta-viewer
// Sequence viewer with colored nucleotides and GC content

(function() {
  var PAGE_SIZE = 50;
  var allSeqs = [];
  var filteredSeqs = [];
  var currentPage = 0;
  var filterText = '';
  var expandedIdx = {};
  var rootEl = null;

  function parse(text) {
    var seqs = [];
    var lines = text.split('\n');
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      if (l[0] === '>') {
        if (cur) seqs.push(cur);
        cur = { header: l.substring(1).trim(), seq: '' };
      } else if (cur) {
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
    var s = seq.substring(0, maxLen || 500);
    var html = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if ('ATUGCN'.indexOf(ch) >= 0) {
        html += '<span class="base-' + ch + '">' + ch + '</span>';
      } else {
        html += ch;
      }
    }
    if (seq.length > (maxLen || 500)) html += '<span style="color:#999">... (' + formatNum(seq.length - (maxLen || 500)) + ' more)</span>';
    return html;
  }

  function applyFilter() {
    var ft = filterText.toLowerCase();
    filteredSeqs = [];
    for (var i = 0; i < allSeqs.length; i++) {
      if (!ft || allSeqs[i].header.toLowerCase().indexOf(ft) >= 0) {
        filteredSeqs.push({ idx: i, data: allSeqs[i] });
      }
    }
    currentPage = 0;
  }

  function _loadPage(page) {
    var target = (rootEl && rootEl.querySelector('#__plugin_content__')) || rootEl;
    if (!target) return;

    _fetchPage(_currentFilename, page).then(function(data) {
      if (data.error) {
        target.innerHTML = '<p style="color:red;padding:16px;">Error: ' + data.error + '</p>';
        return;
      }
      _totalSeqs = data.total || _totalSeqs;
      currentPage = page;
      var text = '';
      if (data.rows) {
        for (var i = 0; i < data.rows.length; i++) {
          var row = data.rows[i];
          text += (Array.isArray(row) ? row.join('\t') : row) + '\n';
        }
      }
      allSeqs = parse(text);
      filteredSeqs = [];
      for (var i = 0; i < allSeqs.length; i++) {
        filteredSeqs.push({ idx: i, data: allSeqs[i] });
      }
      expandedIdx = {};
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

    var totalPages = Math.max(1, Math.ceil(_totalSeqs / PAGE_SIZE));

    var html = '<div class="fasta-plugin">';

    // Summary
    html += '<div class="fasta-summary">';
    html += '<span class="stat"><b>' + formatNum(_totalSeqs) + '</b> sequences</span>';
    html += '<span class="stat"><b>' + formatNum(totalBases) + '</b> bases (this page)</span>';
    html += '<span class="stat">Type: <b>' + seqType + '</b></span>';
    if (seqType !== 'Protein') html += '<span class="stat">Avg GC: <b>' + avgGC + '%</b></span>';
    html += '</div>';

    // Sequence list
    html += '<div class="fasta-list">';
    for (var si = 0; si < filteredSeqs.length; si++) {
      var entry = filteredSeqs[si];
      var globalIdx = currentPage * PAGE_SIZE + entry.idx;
      var seq = entry.data;
      var isOpen = !!expandedIdx[globalIdx];

      html += '<div class="fasta-entry">';
      html += '<div class="fasta-header" data-idx="' + globalIdx + '">';
      html += '<span class="fasta-header-name">' + (isOpen ? '\u25BC ' : '\u25B6 ') + seq.header + '</span>';
      html += '<span class="fasta-header-meta">';
      html += '<span>' + formatNum(seq.seq.length) + ' bp</span>';
      if (seqType !== 'Protein') html += '<span class="gc-badge">GC ' + gcContent(seq.seq) + '%</span>';
      html += '</span>';
      html += '</div>';

      if (isOpen) {
        html += '<div class="fasta-seq">' + colorBases(seq.seq, 2000) + '</div>';
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
      html += '<span class="page-info">Page ' + (currentPage + 1) + ' of ' + totalPages +
        ' (' + formatNum(_totalSeqs) + ' sequences)</span>';
      html += '</div>';
    }

    html += '</div>';
    target.innerHTML = html;

    // Events
    var hdrs = target.querySelectorAll('.fasta-header');
    for (var i = 0; i < hdrs.length; i++) {
      hdrs[i].addEventListener('click', function() {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        expandedIdx[idx] = !expandedIdx[idx];
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

  function _fetchReference() {
    return fetch('/api/reference').then(function(r) { return r.json(); })
      .then(function(d) { _igvRef = d.reference || null; })
      .catch(function() { _igvRef = null; });
  }

  function _loadIgvJs() {
    return new Promise(function(resolve, reject) {
      if (window.igv) { resolve(); return; }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/igv@3/dist/igv.min.js';
      s.onload = function() { resolve(); };
      s.onerror = function() { reject(new Error('Failed to load igv.js')); };
      document.head.appendChild(s);
    });
  }

  function _buildGenomeDropdown() {
    var current = _selectedGenome || _igvRef || '';
    var html = '<span style="font-size:12px;color:#888;font-weight:500;margin-right:4px">Reference:</span>';
    html += '<select id="__igv_genome_select__" style="font-size:12px;padding:4px 8px;max-width:220px;border:1px solid #ddd;border-radius:4px">';
    html += '<option value="' + (_igvRef || '') + '"' + (current === _igvRef ? ' selected' : '') + '>' + (_igvRef || 'none') + '</option>';
    KNOWN_GENOMES.forEach(function(g) {
      if (g.id !== _igvRef) {
        html += '<option value="' + g.id + '"' + (current === g.id ? ' selected' : '') + '>' + g.label + '</option>';
      }
    });
    html += '</select>';
    return html;
  }

  function _renderIgv(container, fileUrl, filename, trackType, trackFormat) {
    container.innerHTML = '<div id="__igv_div__" class="ap-loading">Loading...</div>';
    _loadIgvJs().then(function() {
      var div = document.getElementById('__igv_div__');
      if (!div) return;
      div.innerHTML = '';
      var activeRef = _selectedGenome || _igvRef;
      var opts = {};
      var knownIds = KNOWN_GENOMES.map(function(g) { return g.id; });
      if (knownIds.indexOf(activeRef) >= 0) {
        opts.genome = activeRef;
      } else {
        opts.reference = { fastaURL: '/file/' + encodeURIComponent(activeRef), indexed: false };
      }
      opts.tracks = [{ type: trackType, format: trackFormat, url: fileUrl, name: filename }];
      igv.createBrowser(div, opts);
    }).catch(function(e) {
      container.innerHTML = '<div style="color:red;padding:16px;">IGV Error: ' + e.message + '</div>';
    });
  }

  var TRACK_TYPE = 'sequence';
  var TRACK_FORMAT = 'fasta';

  var _totalSeqs = 0;
  var _currentFilename = '';

  function _fetchPage(filename, page) {
    return fetch('/data/' + encodeURIComponent(filename) + '?page=' + page + '&page_size=' + PAGE_SIZE)
      .then(function(resp) { return resp.json(); });
  }

  function _renderData(container, fileUrl, filename) {
    allSeqs = []; filteredSeqs = []; currentPage = 0; filterText = ''; expandedIdx = {};
    _currentFilename = filename;

    _fetchPage(filename, 0).then(function(data) {
      if (data.error) {
        container.innerHTML = '<p style="color:red;padding:16px;">Error: ' + data.error + '</p>';
        return;
      }
      _totalSeqs = data.total || 0;
      // rows come as arrays of tab-separated fields; join lines and parse as fasta
      var text = '';
      if (data.rows) {
        for (var i = 0; i < data.rows.length; i++) {
          var row = data.rows[i];
          text += (Array.isArray(row) ? row.join('\t') : row) + '\n';
        }
      }
      allSeqs = parse(text);
      applyFilter();
      render();
    }).catch(function(err) {
      container.innerHTML = '<p style="color:red;padding:16px;">Error loading file: ' + err.message + '</p>';
    });
  }

  function _showView(container, fileUrl, filename) {
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
      rootEl = container;
      _igvMode = 'data';
      _selectedGenome = null;

      _fetchReference().then(function() {
        _showView(container, fileUrl, filename);
      });
    },
    destroy: function() { allSeqs = []; filteredSeqs = []; rootEl = null; }
  };
})();
