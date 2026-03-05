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

  function render() {
    if (!rootEl) return;
    var seqType = detectType(allSeqs);
    var totalBases = 0;
    var totalGC = 0;
    for (var i = 0; i < allSeqs.length; i++) {
      totalBases += allSeqs[i].seq.length;
      totalGC += parseFloat(gcContent(allSeqs[i].seq)) * allSeqs[i].seq.length / 100;
    }
    var avgGC = totalBases > 0 ? (totalGC / totalBases * 100).toFixed(1) : '0.0';

    var totalPages = Math.max(1, Math.ceil(filteredSeqs.length / PAGE_SIZE));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    var startIdx = currentPage * PAGE_SIZE;
    var pageSeqs = filteredSeqs.slice(startIdx, startIdx + PAGE_SIZE);

    var html = '<div class="fasta-plugin">';

    // Summary
    html += '<div class="fasta-summary">';
    html += '<span class="stat"><b>' + formatNum(allSeqs.length) + '</b> sequences</span>';
    html += '<span class="stat"><b>' + formatNum(totalBases) + '</b> total bases</span>';
    html += '<span class="stat">Type: <b>' + seqType + '</b></span>';
    if (seqType !== 'Protein') html += '<span class="stat">Avg GC: <b>' + avgGC + '%</b></span>';
    if (filteredSeqs.length !== allSeqs.length) {
      html += '<span class="stat" style="color:#c62828">(' + (allSeqs.length - filteredSeqs.length) + ' filtered out)</span>';
    }
    html += '</div>';

    // Controls
    html += '<div class="fasta-controls">';
    html += '<input type="text" id="fastaFilter" placeholder="Search sequence headers..." value="' + filterText.replace(/"/g, '&quot;') + '">';
    html += '</div>';

    // Sequence list
    html += '<div class="fasta-list">';
    for (var si = 0; si < pageSeqs.length; si++) {
      var entry = pageSeqs[si];
      var globalIdx = entry.idx;
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
      html += '<button data-page="prev">&laquo; Prev</button>';
      var startP = Math.max(0, currentPage - 3);
      var endP = Math.min(totalPages, startP + 7);
      if (startP > 0) html += '<button data-page="0">1</button><span>...</span>';
      for (var p = startP; p < endP; p++) {
        html += '<button data-page="' + p + '"' + (p === currentPage ? ' class="current"' : '') + '>' + (p + 1) + '</button>';
      }
      if (endP < totalPages) html += '<span>...</span><button data-page="' + (totalPages - 1) + '">' + totalPages + '</button>';
      html += '<button data-page="next">Next &raquo;</button>';
      html += '<span class="page-info">Page ' + (currentPage + 1) + ' of ' + totalPages + '</span>';
      html += '</div>';
    }

    html += '</div>';
    rootEl.innerHTML = html;

    // Events
    var fi = rootEl.querySelector('#fastaFilter');
    if (fi) fi.addEventListener('input', function() { filterText = this.value; applyFilter(); render(); });
    var hdrs = rootEl.querySelectorAll('.fasta-header');
    for (var i = 0; i < hdrs.length; i++) {
      hdrs[i].addEventListener('click', function() {
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        expandedIdx[idx] = !expandedIdx[idx];
        render();
      });
    }
    var pbs = rootEl.querySelectorAll('.fasta-pagination button');
    for (var i = 0; i < pbs.length; i++) {
      pbs[i].addEventListener('click', function() {
        var pg = this.getAttribute('data-page');
        if (pg === 'prev') { if (currentPage > 0) currentPage--; }
        else if (pg === 'next') { var tp = Math.ceil(filteredSeqs.length / PAGE_SIZE); if (currentPage < tp - 1) currentPage++; }
        else { currentPage = parseInt(pg, 10); }
        render();
      });
    }
  }

  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      rootEl = container;
      rootEl.innerHTML = '<div class="fasta-loading">Loading ' + filename + '...</div>';
      allSeqs = []; filteredSeqs = []; currentPage = 0; filterText = ''; expandedIdx = {};

      fetch(fileUrl)
        .then(function(resp) { return resp.text(); })
        .then(function(data) {
          allSeqs = parse(data);
          applyFilter();
          render();
        })
        .catch(function(err) {
          rootEl.innerHTML = '<p style="color:red;padding:16px;">Error loading file: ' + err.message + '</p>';
        });
    },
    destroy: function() { allSeqs = []; filteredSeqs = []; rootEl = null; }
  };
})();
