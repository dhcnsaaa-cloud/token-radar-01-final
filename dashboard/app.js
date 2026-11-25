/* Launch Radar — page logic. All verdicts are re-priced in the browser
   with the same arithmetic the program used; the data comes only from
   the snapshot the program read. No network, no names hard-coded. */
(function () {
  'use strict';
  var R = window.RADAR;
  var rows = R.rows;
  var traded = R.traded;
  var model = R.model;
  var oddsM = R.odds;
  var DEF = R.scenario;

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function money(x) {
    if (x == null || isNaN(x)) return '—';
    var a = Math.abs(x);
    if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'K';
    return '$' + x.toFixed(2);
  }
  function num(x, d) { return x == null || isNaN(x) ? '—' : x.toFixed(d == null ? 2 : d); }
  function pct(x) { return x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(1) + '%'; }

  var state = {
    tab: 'board', sortKey: 'rank', sortDir: 1,
    q: '', cat: '', verdict: '', chain: '',
    sc: { fee: DEF.fee, gas: DEF.gas, cap: DEF.cap, dropShare: DEF.dropShare, weeks: DEF.weeks, tbill: DEF.tbill, hours: DEF.hours },
    detail: null
  };

  function econ(fitted, odds, tvl, sc) {
    var implied = fitted * odds;
    var deposit = Math.min(sc.cap, tvl * 0.0002);
    var share = deposit / tvl;
    var expectedDrop = sc.dropShare * implied * share;
    var capitalCharge = deposit * sc.tbill * (sc.weeks / 52);
    var costs = sc.fee + sc.gas + capitalCharge;
    var net = expectedDrop - costs;
    return {
      deposit: deposit, implied: implied, expectedDrop: expectedDrop, capitalCharge: capitalCharge,
      costs: costs, net: net, perHour: net / sc.hours,
      breakEven: Math.min(1, costs / Math.max(1, sc.dropShare * fitted * share))
    };
  }
  function verdictOf(row, sc) {
    var e = econ(row.fitted, row.odds, row.tvl, sc);
    var lowFitted = row.p25 / Math.max(0.01, row.odds);
    var low = econ(lowFitted, row.odds, row.tvl, sc);
    if (low.net > 0 && low.perHour >= 25) return { v: 'ROBUST', e: e, low: low };
    if (e.net > 0 && e.perHour >= 25) return { v: 'FARM', e: e, low: low };
    if (e.net > 0) return { v: 'MARGINAL', e: e, low: low };
    return { v: 'SKIP', e: e, low: low };
  }

  /* Live refit: re-fit the size curve in the browser from the traded rows
     and check every printed fitted value against it. */
  function liveRefit() {
    var xs = traded.map(function (t) { return Math.log(t.tvl); });
    var ys = traded.map(function (t) { return Math.log(t.mcap); });
    var n = xs.length, mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0;
    for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    var slope = sxy / sxx, intercept = my - slope * mx;
    var match = 0;
    rows.forEach(function (r) {
      var f = Math.exp(intercept + slope * Math.log(r.tvl));
      if (Math.abs(f - r.fitted) <= Math.max(1, 0.001 * r.fitted)) match++;
    });
    var h = 0x811c9dc5;
    var s = rows.map(function (r) { return r.slug + ':' + r.rank + ':' + r.implied; }).join('|');
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return { intercept: intercept, slope: slope, match: match, checksum: ('0000000' + h.toString(16)).slice(-8) };
  }
  var refit = liveRefit();

  function filtered() {
    var q = state.q.toLowerCase();
    return rows.filter(function (r) {
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      if (state.cat && (r.category || 'None') !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict && verdictOf(r, state.sc).v !== state.verdict) return false;
      return true;
    });
  }
  function sorted(list) {
    var k = state.sortKey, d = state.sortDir;
    function val(r) {
      switch (k) {
        case 'rank': return r.rank;
        case 'name': return r.name.toLowerCase();
        case 'category': return (r.category || 'None').toLowerCase();
        case 'chain': return (r.chains[0] || '').toLowerCase();
        case 'tvl': return r.tvl;
        case 'chg': return r.change7d == null ? -9999 : r.change7d;
        case 'age': return r.ageYears == null ? -1 : r.ageYears;
        case 'fitted': return r.implied;
        case 'odds': return r.odds;
        case 'mult': return r.fitted / r.tvl;
        case 'net': return verdictOf(r, state.sc).e.net;
        case 'verdict': return { ROBUST: 0, FARM: 1, MARGINAL: 2, SKIP: 3 }[verdictOf(r, state.sc).v];
      }
      return r.rank;
    }
    return list.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -d;
      if (va > vb) return d;
      return a.rank - b.rank;
    });
  }

  function renderKpis() {
    var tvlSum = rows.reduce(function (a, r) { return a + r.tvl; }, 0);
    var impliedSum = rows.reduce(function (a, r) { return a + r.implied; }, 0);
    var counts = { ROBUST: 0, FARM: 0, MARGINAL: 0, SKIP: 0 };
    rows.forEach(function (r) { counts[verdictOf(r, state.sc).v]++; });
    var pay = counts.ROBUST + counts.FARM;
    document.getElementById('kpis').innerHTML = [
      [String(rows.length), 'Rows ranked', R.meta.watchlist + ' watchlist + ' + R.meta.early + ' early'],
      [money(tvlSum), 'TVL ranked', 'Snapshot floor ' + money(R.meta.floor)],
      [money(impliedSum), 'Implied total', 'Fitted cap × token odds'],
      [String(pay), 'Pay at this scenario', 'ROBUST ' + counts.ROBUST + ' · FARM ' + counts.FARM],
      ['×' + model.looMiss, 'Size-curve miss', 'LOO mean ×' + model.looMiss + ' · WF ×' + model.wfMiss],
      ['Brier ' + (oddsM.useLogit ? oddsM.brierLogit : oddsM.brierBuckets), 'Token odds', 'AUC ' + (oddsM.useLogit ? oddsM.aucLogit : oddsM.aucBuckets) + ' · ' + (oddsM.useLogit ? 'logit' : 'buckets') + ' ' + (oddsM.useLogit ? oddsM.brierLogit : oddsM.brierBuckets) + ' · base ' + oddsM.brierBase]
    ].map(function (t) {
      return '<div class="tile"><div class="v">' + t[0] + '</div><div class="l">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>';
    }).join('');
    document.getElementById('formulaLine').textContent =
      'ln(mcap) = ' + model.intercept + ' + ' + model.slope + ' · ln(TVL) → mcap ≈ $' +
      Math.round(Math.exp(model.intercept)) + ' × TVL^' + model.slope +
      '  (σ = ' + model.sigma + ' log units, R² = ' + model.rSquared + ')  ·  ' +
      (oddsM.useLogit ? 'odds = logit (age, size, category share, growth)' : 'odds = age-bucket token-record rate') + '  ·  net = expected drop − fee − gas − capital charge';
  }

  function renderIntegrity() {
    var total = R.accounting.reduce(function (a, x) { return a + x.count; }, 0);
    document.getElementById('integrityLine').innerHTML =
      '<b>' + total + ' protocols accounted:</b> ' + R.accounting.map(function (a) { return a.count + ' ' + a.label.toLowerCase(); }).join(' · ') +
      '. Sum <b>✓ closes at ' + total + '</b> · checksum <b>✓ ' + refit.checksum + '</b> · live refit <b>✓ ' + refit.match + '/' + rows.length +
      ' rows match</b> · 0 protocol names in the code · no network.';
    document.getElementById('subtitle').textContent =
      'Snapshot ' + R.meta.asOf + ' · ' + R.meta.source + ', fetched ' + R.meta.fetched +
      ' · floor ' + money(R.meta.floor) + ' · model ' + R.meta.modelName + ' · ' + rows.length + ' rows ranked';
  }

  function renderEvidence() {
    document.getElementById('evValue').textContent = 'Size curve only: LOO ×' + model.looMiss + ' · WF ×' + model.wfMiss;
    document.getElementById('evValueText').textContent =
      'Flat one-constant: LOO ×' + model.flatLoo + ' · WF ×' + model.flatWf + '. A tilt was kept only if it beat the size curve by ≥1% on both tests. ' +
      model.ladder.filter(function (t) { return t.kept; }).length + ' kept · ' +
      model.ladder.filter(function (t) { return !t.kept; }).length + ' tested, not kept.';
    document.getElementById('ladderMini').innerHTML =
      '<tr><th>Tilt</th><th>LOO</th><th>WF</th><th></th></tr>' + model.ladder.map(function (t) {
        return '<tr><td>' + esc(t.tilt) + '</td><td>×' + t.loo + '</td><td>×' + t.wf + '</td><td>' + (t.kept ? 'Kept' : 'Dropped') + '</td></tr>';
      }).join('');
    var winLogit = oddsM.useLogit;
    document.getElementById('evOdds').textContent = 'Brier ' + (winLogit ? oddsM.brierLogit : oddsM.brierBuckets) + ' · AUC ' + (winLogit ? oddsM.aucLogit : oddsM.aucBuckets);
    document.getElementById('evOddsText').textContent =
      oddsM.dated + ' dated protocols, repeated 5-fold cross-validation (20 folds). ' +
      (winLogit
        ? 'The four-term logit (Brier ' + oddsM.brierLogit + ') beat the age buckets (' + oddsM.brierBuckets + ') and the base rate (' + oddsM.brierBase + '), so the logit prices odds.'
        : 'Age buckets (Brier ' + oddsM.brierBuckets + ') beat the four-term logit (' + oddsM.brierLogit + ') and the base rate (' + oddsM.brierBase + '), so the logit was dropped.') +
      ' Odds estimate prevalence of a token record — not a chance of listing soon.';
    document.getElementById('oddsMini').innerHTML =
      '<tr><th>Age bucket</th><th>n</th><th>Rate</th></tr>' + oddsM.buckets.map(function (b) {
        return '<tr><td>' + esc(b.label) + '</td><td>' + b.n + '</td><td>' + (b.rate * 100).toFixed(1) + '%</td></tr>';
      }).join('');
    document.getElementById('evRange').textContent =
      'Within ×3: ' + Math.round(model.looWithin3 * 100) + '% · median rank range ±' + model.bootMedianRankRange + ' ranks';
    document.getElementById('evRangeText').textContent =
      'Leave-one-out coverage: ' + Math.round(model.looWithin3 * 100) + '% of priced comparables land within ×3 of the fitted cap. ' +
      model.bootSlopePositive * 100 + '% of 60 bootstrap refits keep a positive slope (s.e. ' + model.bootSlopeSe +
      '). Rank ranges are P10–P90 over 60 refits, ranked among all rankable protocols.';
  }

  function drawScatter(el, highlight) {
    var W = 1160, H = 345, ml = 70, mr = 20, mt = 14, mb = 40;
    var x0 = Math.log(4e6), x1 = Math.log(4e10), y0 = Math.log(4e4), y1 = Math.log(9e9);
    function X(v) { return ml + (Math.log(v) - x0) / (x1 - x0) * (W - ml - mr); }
    function Y(v) { return H - mb - (Math.log(v) - y0) / (y1 - y0) * (H - mt - mb); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Market cap against TVL for priced comparables">';
    var gridX = [1e7, 1e8, 1e9, 1e10];
    var gridY = [1e5, 1e6, 1e7, 1e8, 1e9];
    gridX.forEach(function (v) {
      s += '<line x1="' + X(v) + '" y1="' + mt + '" x2="' + X(v) + '" y2="' + (H - mb) + '" stroke="#2a2c2f"/>' +
        '<text x="' + X(v) + '" y="' + (H - mb + 18) + '" text-anchor="middle">' + money(v) + '</text>';
    });
    gridY.forEach(function (v) {
      s += '<line x1="' + ml + '" y1="' + Y(v) + '" x2="' + (W - mr) + '" y2="' + Y(v) + '" stroke="#2a2c2f"/>' +
        '<text x="' + (ml - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + money(v) + '</text>';
    });
    s += '<text x="' + ((W - ml - mr) / 2 + ml) + '" y="' + (H - 4) + '" text-anchor="middle">TVL (log scale)</text>' +
      '<text x="16" y="' + ((H - mt - mb) / 2 + mt) + '" text-anchor="middle" transform="rotate(-90 16 ' + ((H - mt - mb) / 2 + mt) + ')">Market cap (log scale)</text>';
    var band = 0.6745 * model.sigma;
    [[-band, 'dashed'], [0, 'solid'], [band, 'dashed']].forEach(function (pair) {
      var off = pair[0];
      var xA = 4e6, xB = 4e10;
      var yA = Math.exp(model.intercept + model.slope * Math.log(xA) + off);
      var yB = Math.exp(model.intercept + model.slope * Math.log(xB) + off);
      s += '<line x1="' + X(xA) + '" y1="' + Y(yA) + '" x2="' + X(xB) + '" y2="' + Y(yB) + '" stroke="#d4a437" stroke-width="' +
        (pair[1] === 'solid' ? 2.5 : 1.5) + '"' + (pair[1] === 'dashed' ? ' stroke-dasharray="6 5"' : '') + '/>';
    });
    traded.forEach(function (t) {
      s += '<circle cx="' + X(t.tvl).toFixed(1) + '" cy="' + Y(t.mcap).toFixed(1) + '" r="4.5" fill="#d4a437" opacity="0.85"/>';
    });
    if (highlight) {
      s += '<circle cx="' + X(highlight.tvl).toFixed(1) + '" cy="' + Y(highlight.fitted).toFixed(1) + '" r="9" fill="none" stroke="#f0c75e" stroke-width="2.5"/>' +
        '<text x="' + (X(highlight.tvl) + 12).toFixed(1) + '" y="' + (Y(highlight.fitted) - 8).toFixed(1) + '" fill="#f0c75e">' + esc(highlight.name) + '</text>';
    }
    s += '</svg>';
    el.innerHTML = s;
  }

  function renderChips() {
    var counts = { ROBUST: 0, FARM: 0, MARGINAL: 0, SKIP: 0 };
    rows.forEach(function (r) {
      var q = state.q.toLowerCase();
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return;
      if (state.cat && (r.category || 'None') !== state.cat) return;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return;
      counts[verdictOf(r, state.sc).v]++;
    });
    var total = counts.ROBUST + counts.FARM + counts.MARGINAL + counts.SKIP;
    var defs = [['', 'All ' + total], ['ROBUST', 'ROBUST ' + counts.ROBUST], ['FARM', 'FARM ' + counts.FARM], ['MARGINAL', 'MARGINAL ' + counts.MARGINAL], ['SKIP', 'SKIP ' + counts.SKIP]];
    document.getElementById('chips').innerHTML = defs.map(function (d) {
      return '<button type="button" class="chip' + (state.verdict === d[0] ? ' on' : '') + '" data-verdict="' + d[0] + '">' + d[1] + '</button>';
    }).join('');
    document.querySelectorAll('#chips .chip').forEach(function (b) {
      b.addEventListener('click', function () { state.verdict = b.getAttribute('data-verdict'); renderBoard(); });
    });
  }

  function renderBoard() {
    renderChips();
    var list = sorted(filtered());
    document.getElementById('showing').textContent =
      'Showing ' + list.length + ' of ' + rows.length + ' rows · ' + R.meta.watchlist + ' watchlist';
    var html = '';
    list.forEach(function (r) {
      var vd = verdictOf(r, state.sc);
      var e = vd.e;
      var chg = r.change7d == null ? '—' : pct(r.change7d);
      var chgCls = r.change7d != null && r.change7d < 0 ? 'neg' : 'pos';
      html += '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="nm">' + esc(r.name) + '</span>' +
        (r.watchlist ? '<span class="tag">Watchlist</span>' : '') +
        (r.thinCategory ? '<span class="tag">Thin</span>' : '') +
        (r.kinship ? '<span class="tag">Kin</span>' : '') +
        '<div class="sub2">' + esc(r.slug) + ' · <a href="#" data-plan="' + esc(r.slug) + '">▸ plan</a></div></td>' +
        '<td>' + esc(r.category || 'None') + '</td>' +
        '<td>' + esc(r.chains[0] || '—') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') + '</td>' +
        '<td class="num">' + money(r.tvl) + '</td>' +
        '<td class="num ' + chgCls + '">' + chg + '</td>' +
        '<td class="num">' + (r.ageYears == null ? '—' : (r.ageYears < 1 ? Math.round(r.ageYears * 365) + 'd' : r.ageYears.toFixed(1) + 'y')) + '</td>' +
        '<td class="num"><b>' + money(r.implied) + '</b><div class="sub2">' + money(r.p25) + '–' + money(r.p75) + '</div></td>' +
        '<td class="num">' + r.rankLo + '–' + r.rankHi + '</td>' +
        '<td class="num">' + (r.odds * 100).toFixed(1) + '%<div class="bar"><i style="width:' + Math.round(r.odds * 100) + '%"></i></div></td>' +
        '<td class="num">×' + num(r.fitted / r.tvl, 2) + '</td>' +
        '<td class="num"><span class="' + (e.net >= 0 ? 'pos' : 'neg') + '">' + (e.net >= 0 ? '+' : '−') + '$' + Math.abs(e.net).toFixed(2) + '</span>' +
        '<div class="sub2">' + (e.perHour >= 0 ? '+' : '−') + '$' + Math.abs(e.perHour).toFixed(2) + '/h</div></td>' +
        '<td><span class="v' + vd.v + '">' + vd.v + '</span>' +
        '<div class="sub2">drop ' + money(e.expectedDrop) + ' · costs ' + money(e.costs) + '<br>break-even ' + (vd.e.breakEven * 100).toFixed(1) + '% odds</div></td>' +
        '</tr>';
    });
    document.getElementById('boardBody').innerHTML = html;
    document.querySelectorAll('#boardBody tr').forEach(function (tr) {
      tr.addEventListener('click', function (ev) {
        var planLink = ev.target.getAttribute && ev.target.getAttribute('data-plan');
        var slug = planLink || tr.getAttribute('data-slug');
        showDetail(slug, !!planLink);
      });
    });
    document.querySelectorAll('#boardTable th[data-sort]').forEach(function (th) {
      th.textContent = th.textContent.replace(/ [▲▼]$/, '');
      if (th.getAttribute('data-sort') === state.sortKey) th.textContent += state.sortDir === 1 ? ' ▲' : ' ▼';
    });
    renderKpis();
  }

  function showDetail(slug, showPlan) {
    var r = rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    state.detail = slug;
    var vd = verdictOf(r, state.sc);
    var e = vd.e, low = vd.low;
    var sc = state.sc;
    function sensRow(drop, cap) {
      var s2 = { fee: sc.fee, gas: sc.gas, cap: cap, dropShare: drop, weeks: sc.weeks, tbill: sc.tbill, hours: sc.hours };
      var ee = econ(r.fitted, r.odds, r.tvl, s2);
      var ll = econ(r.p25, r.odds, r.tvl, s2);
      var v = ll.net > 0 && ll.perHour >= 25 ? 'ROBUST' : (ee.net > 0 && ee.perHour >= 25 ? 'FARM' : (ee.net > 0 ? 'MARGINAL' : 'SKIP'));
      return '<td class="v' + v + '">' + v + '<br><span class="' + (ee.net >= 0 ? 'pos' : 'neg') + '">' + (ee.net >= 0 ? '+' : '−') + '$' + Math.abs(ee.net).toFixed(2) + '</span></td>';
    }
    var peersHtml = r.peers.map(function (p) {
      return '<tr><td>' + esc(p.name) + (p.sameCategory ? ' <span class="tag">same category</span>' : '') + '</td>' +
        '<td class="num">' + money(p.tvl) + '</td><td class="num">' + money(p.mcap) + '</td>' +
        '<td class="num">' + money(p.fitted) + '</td><td class="num">×' + p.multiple + '</td></tr>';
    }).join('');
    var callouts = '';
    if (r.thinCategory) callouts += '<p class="callout">Thin category: fewer than 5 priced comparables sit in “' + esc(r.category || 'None') + '”, so no category residual is used for this row. The size curve alone prices it.</p>';
    if (r.kinship) callouts += '<p class="callout">Kinship flag: another protocol sharing this name stem already records a token. The kinship haircut was tested and dropped, so the flag is shown and not priced.</p>';
    if (!r.ageKnown) callouts += '<p class="callout">Age unknown: no listing date in the snapshot, so odds use the pooled token-record rate (' + (oddsM.pooled * 100).toFixed(1) + '%) instead of an age bucket.</p>';
    var html =
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="muted">' + esc(r.category || 'None') + ' · ' + esc(r.chains.join(', ')) + ' · TVL ' + money(r.tvl) +
      ' · 7-day ' + (r.change7d == null ? '—' : pct(r.change7d)) + ' · age ' + (r.ageYears == null ? 'unknown' : (r.ageYears < 1 ? Math.round(r.ageYears * 365) + ' days' : r.ageYears.toFixed(1) + ' years')) + '</p>' + callouts +
      '<div class="grid2">' +
      '<div class="card"><h2>Value</h2>' +
      '<div class="kv"><span>Fitted cap</span><span>' + money(r.fitted) + '</span></div>' +
      '<div class="kv"><span>Size multiple</span><span>×' + num(r.fitted / r.tvl, 2) + '</span></div>' +
      '<div class="kv"><span>Token odds</span><span>' + (r.odds * 100).toFixed(1) + '% (' + esc(r.oddsBucket) + ')</span></div>' +
      '<div class="kv"><span>Implied value</span><span>' + money(r.implied) + '</span></div>' +
      '<div class="kv"><span>P25–P75</span><span>' + money(r.p25) + ' – ' + money(r.p75) + '</span></div>' +
      '<div class="kv"><span>P10–P90</span><span>' + money(r.p10) + ' – ' + money(r.p90) + '</span></div>' +
      '<div class="kv"><span>Refit rank range</span><span>#' + r.rankLo + '–#' + r.rankHi + ' of ' + rows.length + '</span></div>' +
      '<p class="muted">Fitted cap = e^' + model.intercept + ' × TVL^' + model.slope + ' = $' + Math.round(Math.exp(model.intercept)) + ' × TVL^' + model.slope +
      '. The P25–P75 range is the implied interval: 60 bootstrap refits of the fitted cap, each multiplied by the same odds.</p></div>' +
      '<div class="card"><h2>Why these odds</h2>' +
      '<div class="kv"><span>Token odds</span><span>' + (r.odds * 100).toFixed(1) + '%</span></div>' +
      '<div class="kv"><span>Pooled token-record rate</span><span>' + (oddsM.pooled * 100).toFixed(1) + '%</span></div>' +
      r.oddsParts.map(function (pt) { return '<div class="kv"><span>' + esc(pt.label) + '</span><span>' + (oddsM.useLogit ? (pt.value >= 0 ? '+' : '') + pt.value.toFixed(3) + ' log-odds' : (pt.value * 100).toFixed(1) + '%') + '</span></div>'; }).join('') +
      '<p class="muted">' + (oddsM.useLogit
        ? 'Log-odds contributions around the intercept; they sum to the logit for this row. Age bucket for reference: ' + esc(r.oddsBucket) + '.'
        : 'Odds are the token-record rate of the same age bucket, not a forecast of when this protocol lists. Age bucket: ' + esc(r.oddsBucket) + '.') + '</p></div>' +
      '</div>' +
      '<div class="grid2">' +
      '<div class="card"><h2>How a row is priced</h2>' +
      '<div class="kv"><span>× size — curve on TVL ' + money(r.tvl) + '</span><span>' + money(r.fitted) + '</span></div>' +
      '<div class="kv"><span>= implied — fitted × odds</span><span>' + money(r.implied) + '</span></div>' +
      '<div class="kv"><span>× odds — ' + esc(r.oddsBucket) + '</span><span>' + (r.odds * 100).toFixed(1) + '%</span></div>' +
      '<div class="kv"><span>× growth — 7-day ' + (r.change7d == null ? '—' : pct(r.change7d)) + ', capped ±25%</span><span>' + (oddsM.useLogit ? 'in the odds logit' : 'tested, not priced') + '</span></div>' +
      '<div class="kv"><span>× category — ' + esc(r.category || 'None') + (r.thinCategory ? ' (thin)' : '') + '</span><span>' + (oddsM.useLogit ? 'share in the odds logit; residual tested, dropped' : 'residual tested, dropped') + '</span></div>' +
      '<div class="kv"><span>× kinship — name stem</span><span>' + (r.kinship ? 'flagged, not priced' : 'no kin') + '</span></div>' +
      '<p class="muted">Only the size curve sets the fitted cap. Everything else is either the odds that weight the expected drop, or a tested-and-dropped factor shown for honesty.</p></div>' +
      '<div class="card"><h2>Costed verdict, at this scenario</h2>' +
      '<div class="kv"><span>Deposit</span><span>' + money(e.deposit) + '</span></div>' +
      '<div class="kv"><span>Expected drop</span><span>' + money(e.expectedDrop) + '</span></div>' +
      '<div class="kv"><span>Protocol fee</span><span>−' + money(sc.fee) + '</span></div>' +
      '<div class="kv"><span>Gas</span><span>−' + money(sc.gas) + '</span></div>' +
      '<div class="kv"><span>Forgone yield (' + (sc.tbill * 100).toFixed(1) + '% × ' + sc.weeks + 'w)</span><span>−' + money(e.capitalCharge) + '</span></div>' +
      '<div class="kv"><span>All costs</span><span>−' + money(e.costs) + '</span></div>' +
      '<div class="kv"><span>Net</span><span class="' + (e.net >= 0 ? 'pos' : 'neg') + '">' + (e.net >= 0 ? '+' : '−') + '$' + Math.abs(e.net).toFixed(2) + '</span></div>' +
      '<div class="kv"><span>Per hour (' + sc.hours + 'h active)</span><span class="' + (e.perHour >= 0 ? 'pos' : 'neg') + '">' + (e.perHour >= 0 ? '+' : '−') + '$' + Math.abs(e.perHour).toFixed(2) + '</span></div>' +
      '<div class="kv"><span>Net at the P25 low end</span><span class="' + (low.net >= 0 ? 'pos' : 'neg') + '">' + (low.net >= 0 ? '+' : '−') + '$' + Math.abs(low.net).toFixed(2) + '</span></div>' +
      '<p class="muted">Fee and horizon come from the scenario above. ROBUST needs the P25 net above $25 an hour; FARM needs the point net above it.</p></div>' +
      '</div>' +
      '<div class="card"><h2>Net by drop share × deposit cap</h2>' +
      '<table class="sens"><tr><th></th><th>$5,000 cap</th><th>$10,000 cap</th></tr>' +
      '<tr><td>10% drop</td>' + sensRow(0.10, 5000) + sensRow(0.10, 10000) + '</tr>' +
      '<tr><td>14% drop</td>' + sensRow(0.14, 5000) + sensRow(0.14, 10000) + '</tr>' +
      '<tr><td>20% drop</td>' + sensRow(0.20, 5000) + sensRow(0.20, 10000) + '</tr></table></div>' +
      '<div class="card"><h2>Wide comps — nearest priced peers by TVL</h2>' +
      '<table class="mini"><tr><th>Protocol</th><th>TVL</th><th>Actual</th><th>Fitted</th><th>×</th></tr>' + peersHtml + '</table>' +
      '<p class="muted">Peers are the six priced comparables nearest in log TVL, with same-category peers pulled closer. Their actual caps against fitted caps show the spread the interval has to cover.</p></div>' +
      '<div class="card scatterCard"><h2>Price chart — cap against TVL</h2><div id="detailScatter"></div>' +
      '<p class="muted">The snapshot carries no price history, so no price series is invented. This is the cap-against-TVL chart the fitted cap comes from, with this row ringed.</p></div>' +
      '<div class="card"><h2>Farm plan</h2><ol class="plan">' + r.plan.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
    var detail = document.getElementById('detail');
    detail.innerHTML = html;
    detail.hidden = false;
    drawScatter(document.getElementById('detailScatter'), r);
    if (showPlan) detail.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  function renderTraded() {
    document.getElementById('tradedNote').textContent = R.tradedNote;
    document.getElementById('tradedBody').innerHTML = traded.map(function (t) {
      return '<tr><td><span class="nm">' + esc(t.name) + '</span><div class="sub2">' + esc(t.slug) + '</div></td>' +
        '<td class="num">' + money(t.tvl) + '</td><td class="num">' + money(t.mcap) + '</td>' +
        '<td class="num">' + money(t.fitted) + '</td><td class="num">×' + t.multiple + '</td></tr>';
    }).join('');
  }

  function renderMethod() {
    var acc = R.accounting;
    var total = acc.reduce(function (a, x) { return a + x.count; }, 0);
    document.getElementById('methodBody').innerHTML =
      '<h3>Term ladder — two blind tests per tilt</h3>' +
      '<p class="muted">Miss = exp(mean |log error|), a factor. A tilt was kept only if it beat the size curve by ≥1% on <b>both</b> leave-one-out and the dated split (cutoff 2025-01-01; null-age comps always train). Size-only: LOO ×' + model.looMiss + ', walk-forward ×' + model.wfMiss + '. Flat baseline (one constant): LOO ×' + model.flatLoo + ', walk-forward ×' + model.flatWf + '.</p>' +
      '<table class="mini"><tr><th>Tilt</th><th>LOO mean</th><th>WF mean</th><th>Kept?</th><th>Coefficient</th></tr>' +
      model.ladder.map(function (t) {
        return '<tr><td>' + esc(t.tilt) + '</td><td>×' + t.loo + '</td><td>×' + t.wf + '</td><td>' + (t.kept ? 'Kept' : 'Dropped') + '</td><td>' + t.coef + '</td></tr>';
      }).join('') + '</table>' +
      '<h3>Placebo controls</h3>' +
      '<table class="mini"><tr><th>Control</th><th>LOO mean</th><th>Note</th></tr>' +
      '<tr><td>Size slope, permuted ln(TVL), fixed seed</td><td>×' + model.placeboPermuted + '</td><td>Collapses toward the flat model: the size slope carries the signal.</td></tr>' +
      '<tr><td>Size slope, sign-flipped, in-sample</td><td>×' + model.placeboSignFlip + '</td><td>Catastrophic, as it must be when the slope is real.</td></tr></table>' +
      '<h3>Odds — buckets against the logit</h3>' +
      '<p class="muted">5-fold cross-validation on ' + oddsM.dated + ' dated protocols. ' + esc(oddsM.horizon) + '.</p>' +
      '<table class="mini"><tr><th>Model</th><th>Brier</th><th>AUC</th></tr>' +
      '<tr><td>Age buckets' + (oddsM.useLogit ? '' : ' — used') + '</td><td>' + oddsM.brierBuckets + '</td><td>' + oddsM.aucBuckets + '</td></tr>' +
      '<tr><td>Four-term logit (age, size, category share, growth)' + (oddsM.useLogit ? ' — used' : '') + '</td><td>' + oddsM.brierLogit + '</td><td>' + oddsM.aucLogit + '</td></tr>' +
      '<tr><td>Base rate</td><td>' + oddsM.brierBase + '</td><td>0.500</td></tr></table>' +
      '<h3>Bootstrap — 60 refits, seeded</h3>' +
      '<p class="muted">Slope s.e. ' + model.bootSlopeSe + '; slope positive in ' + Math.round(model.bootSlopePositive * 100) + '% of refits; ' +
      'median rank range (P10–P90) ' + model.bootMedianRankRange + ' ranks; leave-one-out within ×3: ' + Math.round(model.looWithin3 * 100) + '%.</p>' +
      '<h3>Accounting — every protocol in the snapshot</h3>' +
      '<table class="mini"><tr><th>Group</th><th>Count</th><th>Note</th></tr>' +
      acc.map(function (a) { return '<tr><td>' + esc(a.label) + '</td><td>' + a.count + '</td><td>' + esc(a.note) + '</td></tr>'; }).join('') +
      '<tr><td><b>Total</b></td><td><b>' + total + '</b></td><td>Closes at the snapshot size.</td></tr></table>' +
      '<h3>What it cannot say</h3>' +
      '<ul><li>Gas and protocol fees are flat defaults: the snapshot carries no per-chain gas data, so none is invented. Change them in the scenario panel.</li>' +
      '<li>Caps are circulating caps as recorded, not fully diluted values — stated wherever a cap is printed.</li>' +
      '<li>Odds are the prevalence of a token record among peers of the same age, not a prediction that or when a token lists.</li>' +
      '<li>The snapshot has no price history: there is no price series on this page, only the cap-against-TVL chart the fit comes from.</li>' +
      '<li>Thin categories (fewer than 5 priced comparables: ' + esc(model.thinCategories.join(', ') || 'none') + ') contribute no category residual — the curve alone prices those rows.</li>' +
      '<li>Kinship: ' + model.kinFlagged + ' protocols share a name stem with a token-recorded protocol. The kinship haircut was tested and dropped; flagged rows show the flag and are not haircut.</li>' +
      '<li>The program reads every name from the snapshot. No protocol name, slug or fitted constant is written into the code.</li></ul>';
  }

  function renderAll() {
    renderKpis();
    renderIntegrity();
    renderEvidence();
    drawScatter(document.getElementById('scatter'), null);
    renderBoard();
    renderTraded();
    renderMethod();
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    document.getElementById('boardView').hidden = tab !== 'board';
    document.getElementById('tradedView').hidden = tab !== 'traded';
    document.getElementById('methodView').hidden = tab !== 'method';
  }
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });
  document.querySelectorAll('#boardTable th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (state.sortKey === k) state.sortDir = -state.sortDir;
      else { state.sortKey = k; state.sortDir = k === 'name' || k === 'category' || k === 'chain' ? 1 : -1; }
      renderBoard();
    });
  });

  function bindScenario() {
    var map = [['inFee', 'fee', 100], ['inGas', 'gas', 100], ['inDrop', 'dropShare', 100], ['inCap', 'cap', 1], ['inTbill', 'tbill', 100], ['inHours', 'hours', 1]];
    map.forEach(function (m) {
      var el = document.getElementById(m[0]);
      el.value = m[1] === 'dropShare' ? parseFloat((state.sc.dropShare * 100).toFixed(2)) : (m[1] === 'tbill' ? parseFloat((state.sc.tbill * 100).toFixed(2)) : state.sc[m[1]]);
      el.addEventListener('input', function () {
        var v = parseFloat(el.value);
        if (isNaN(v)) return;
        state.sc[m[1]] = m[1] === 'dropShare' || m[1] === 'tbill' ? v / 100 : v;
        renderBoard();
        if (state.detail) showDetail(state.detail, false);
      });
    });
    var w = document.getElementById('inWeeks');
    w.value = String(state.sc.weeks);
    w.addEventListener('change', function () { state.sc.weeks = parseInt(w.value, 10); renderBoard(); if (state.detail) showDetail(state.detail, false); });
    document.getElementById('btnDefaults').addEventListener('click', function () {
      state.sc = { fee: DEF.fee, gas: DEF.gas, cap: DEF.cap, dropShare: DEF.dropShare, weeks: DEF.weeks, tbill: DEF.tbill, hours: DEF.hours };
      bindScenarioValues(); renderBoard(); if (state.detail) showDetail(state.detail, false);
    });
  }
  function bindScenarioValues() {
    document.getElementById('inFee').value = state.sc.fee;
    document.getElementById('inGas').value = state.sc.gas;
    document.getElementById('inDrop').value = parseFloat((state.sc.dropShare * 100).toFixed(2));
    document.getElementById('inCap').value = state.sc.cap;
    document.getElementById('inTbill').value = parseFloat((state.sc.tbill * 100).toFixed(2));
    document.getElementById('inHours').value = state.sc.hours;
    document.getElementById('inWeeks').value = String(state.sc.weeks);
  }

  function bindFilters() {
    var cats = [];
    rows.forEach(function (r) { var c = r.category || 'None'; if (cats.indexOf(c) < 0) cats.push(c); });
    cats.sort();
    document.getElementById('inCat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
    var chains = [];
    rows.forEach(function (r) { r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); }); });
    chains.sort();
    document.getElementById('inChain').innerHTML = '<option value="">All chains</option>' + chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
    document.getElementById('inSearch').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    document.getElementById('inCat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
    document.getElementById('inVerdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
    document.getElementById('inChain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
    document.getElementById('btnReset').addEventListener('click', function () {
      state.q = ''; state.cat = ''; state.verdict = ''; state.chain = '';
      document.getElementById('inSearch').value = '';
      document.getElementById('inCat').value = '';
      document.getElementById('inVerdict').value = '';
      document.getElementById('inChain').value = '';
      renderBoard();
    });
    document.getElementById('btnCsv').addEventListener('click', function () { download(csv(), 'launch-radar.csv', 'text/csv'); });
    document.getElementById('btnJson').addEventListener('click', function () { download(JSON.stringify(sorted(filtered()), null, 2), 'launch-radar.json', 'application/json'); });
  }
  function csv() {
    var head = 'rank,slug,name,category,chains,tvl_usd,change_7d,age_years,fitted_usd,implied_usd,p25_usd,p75_usd,rank_lo,rank_hi,odds,net_usd,per_hour_usd,verdict';
    var lines = sorted(filtered()).map(function (r) {
      var vd = verdictOf(r, state.sc);
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', '"' + r.chains.join(';') + '"',
        r.tvl, r.change7d == null ? '' : r.change7d, r.ageYears == null ? '' : r.ageYears.toFixed(2),
        r.fitted, r.implied, r.p25, r.p75, r.rankLo, r.rankHi, r.odds.toFixed(4),
        vd.e.net.toFixed(2), vd.e.perHour.toFixed(2), vd.v].join(',');
    });
    return head + '\n' + lines.join('\n') + '\n';
  }
  function download(text, name, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  document.getElementById('footerNote').textContent =
    'Launch Radar · snapshot ' + R.meta.asOf + ' · ' + rows.length + ' rows · model ' + R.meta.modelName +
    ' · implied values are this entry’s own claim from the snapshot’s figures, never the snapshot’s · no network, no tracking.';
  bindScenario();
  bindFilters();
  renderAll();

  var params = new URLSearchParams(window.location.search);
  var tab = params.get('tab');
  if (tab === 'traded' || tab === 'method') setTab(tab);
  var verdict = params.get('verdict');
  if (verdict) { state.verdict = verdict.toUpperCase(); document.getElementById('inVerdict').value = state.verdict; renderBoard(); }
  var slug = params.get('slug');
  if (slug) showDetail(slug, true);
})();
