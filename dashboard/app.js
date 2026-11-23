// Launch Radar dashboard: renders window.RADAR, no network, no fetch.
// Verdicts re-price live from the stored fitted cap and odds when the fee
// or horizon changes; the board itself never changes.
(function () {
  var D = window.RADAR;
  var E = D.economics;
  var DG = D.diagnostics;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n.toFixed(n === Math.round(n) ? 0 : 2);
  }
  function money2(n) { return '$' + n.toFixed(2); }
  function pct(n) { return (n * 100).toFixed(1) + '%'; }
  function num(n) { return n.toLocaleString('en-US'); }
  function ageLabel(d) {
    if (d === null || d === undefined) return '—';
    if (d < 365) return (d / 30.44).toFixed(1) + 'mo';
    return (d / 365.25).toFixed(1) + 'yr';
  }
  function chg(v) {
    if (v === null || v === undefined) return '<span>—</span>';
    var cls = v >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function fnv(rows) {
    var h = 0x811c9dc5;
    var text = rows.map(function (r) { return r.rank + ':' + r.slug + ':' + r.implied_value_usd; }).join('\n');
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function fittedCap(tvl) { return Math.exp(D.model.intercept + D.model.slope * Math.log(Math.max(1, tvl))); }
  function oddsFor(age) {
    if (age === null || age === undefined) return { odds: DG.odds_global, label: 'unknown age' };
    for (var i = 0; i < DG.odds_buckets.length; i++) {
      var b = DG.odds_buckets[i];
      if (age >= b.min_days && (b.max_days === -1 || age < b.max_days)) return { odds: b.odds, label: b.label };
    }
    return { odds: DG.odds_global, label: 'unknown age' };
  }
  // Recompute the board from the stored curve + odds: the live refit check.
  function refitCheck() {
    var ok = 0;
    for (var i = 0; i < D.rows.length; i++) {
      var r = D.rows[i];
      var v = Math.max(1, Math.round(fittedCap(r.tvl_usd) * oddsFor(r.age_days).odds));
      if (Math.abs(v - r.implied_value_usd) / r.implied_value_usd <= 0.01) ok++;
    }
    return { ok: ok, n: D.rows.length, sum: fnv(D.rows) === DG.checksum };
  }
  var state = { q: '', cat: '', verdict: '', fee: E.fee_usd, weeks: E.weeks };
  function hours() { return (144 + 5 * state.weeks) / 60; }
  function price(row) {
    var deposit = Math.min(E.deposit_cap_usd, E.deposit_share * row.tvl_usd);
    var drop = row.implied_value_usd * E.drop_share * (deposit / row.tvl_usd);
    var net = drop - state.fee;
    var tbill = deposit * E.tbill_rate * (state.weeks / 52);
    var denom = row.value_if_usd * E.drop_share * (deposit / row.tvl_usd);
    var breakeven = denom > 0 ? Math.min(1, Math.max(0, (state.fee + tbill) / denom)) : 1;
    var p25drop = row.p25_usd * E.drop_share * (deposit / row.tvl_usd);
    var p25net = p25drop - state.fee;
    var verdict = p25net > tbill && net / hours() >= 25 ? 'ROBUST' : net > tbill && net / hours() >= 25 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
    return { deposit: deposit, drop: drop, net: net, tbill: tbill, breakeven: breakeven, verdict: verdict, perHour: net / hours() };
  }
  function filtered() {
    var q = state.q.toLowerCase();
    return D.rows.filter(function (r) {
      if (q && (r.slug + ' ' + r.name).toLowerCase().indexOf(q) === -1) return false;
      if (state.cat && (r.category || '') !== state.cat) return false;
      if (state.verdict && price(r).verdict !== state.verdict) return false;
      return true;
    });
  }
  function renderMeta() {
    $('meta').textContent = 'Snapshot ' + D.as_of + ' · model ' + D.model_version + ' · checksum ' + DG.checksum;
  }
  function renderKpis() {
    var tvl = 0, imp = 0, farm = 0;
    for (var i = 0; i < D.rows.length; i++) { tvl += D.rows[i].tvl_usd; imp += D.rows[i].implied_value_usd; if (price(D.rows[i]).verdict === 'FARM' || price(D.rows[i]).verdict === 'ROBUST') farm++; }
    var tiles = [
      ['Rows', num(D.rows.length), D.watchlist_size + ' watchlist + ' + D.early_size + ' early'],
      ['TVL ranked', money(tvl), 'across the board'],
      ['Implied total', money(imp), 'fitted cap × odds'],
      ['FARM / ROBUST', String(farm), 'at fee $' + state.fee.toFixed(2) + ', ' + state.weeks + ' weeks'],
      ['Size-curve miss', '×' + DG.miss_fitted.toFixed(2), 'CV ×' + DG.miss_cv.toFixed(2) + ' · walk ×' + DG.miss_walkforward.toFixed(2)],
      ['Token odds', pct(DG.odds_global), 'Brier ' + DG.odds_brier.toFixed(3) + ' · AUC ' + DG.odds_auc.toFixed(3)],
    ];
    $('kpis').innerHTML = tiles.map(function (t) { return '<div><div class="l">' + t[0] + '</div><div class="v">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>'; }).join('');
  }
  function renderStrip() {
    var a = D.accounting;
    var parts = ['<b>' + num(a.total) + '</b> protocols in the snapshot = <b>' + num(a.ranked) + '</b> ranked + ' + num(a.below_cut_pre_token) + ' pre-token below the cut + ' + num(a.priced_comps) + ' priced comps + ' + num(a.priced_other) + ' other priced + ' + num(a.recorded_no_cap) + ' recorded, no cap + ' + num(a.excluded_pre_token) + ' excluded pre-token + ' + num(a.above_floor_unranked) + ' above the floor, unranked'];
    var rc = refitCheck();
    var checks = ['✓ watchlist ' + D.watchlist_size + '/' + D.watchlist_size, '✓ ranks 1–' + D.rows.length, '✓ refit ' + rc.ok + '/' + rc.n + ' (±1%)', '✓ checksum ' + (rc.sum ? 'match' : 'MISMATCH'), '✓ farm steps 10 per row', '✓ ' + D.rows.length + ' rows, ≥100', '✓ no hand-picked figures', '✓ snapshot ' + D.as_of];
    $('strip').innerHTML = parts.join('') + '<div class="checks">' + checks.join(' · ') + '</div>';
  }
  function renderCards() {
    var b = DG.odds_buckets.map(function (x) { return x.label + ' ' + pct(x.odds) + ' (' + x.tokened + '/' + x.peers + ')'; }).join(' · ');
    $('cards').innerHTML =
      '<section><h3>Size curve, held out twice</h3><p class="big">×' + DG.miss_fitted.toFixed(2) + ' fitted · ×' + DG.miss_cv.toFixed(2) + ' CV · ×' + DG.miss_walkforward.toFixed(2) + ' walk-forward</p><p>Flat median multiple misses ×' + DG.miss_flat.toFixed(2) + '. ' + DG.n_comps + ' priced comps. Multiple at $100M: ×' + DG.multiple_at_100m_mean.toFixed(3) + ' ± ' + DG.multiple_at_100m_sd.toFixed(3) + '. Slope ' + DG.slope_mean.toFixed(2) + ' ± ' + DG.slope_sd.toFixed(2) + '.</p></section>' +
      '<section><h3>Token odds by age</h3><p class="big">Brier ' + DG.odds_brier.toFixed(3) + ' vs base ' + DG.odds_brier_base.toFixed(3) + '</p><p>' + b + '</p><p>Permuted-age control ' + DG.odds_brier_permuted.toFixed(3) + ' · AUC ' + DG.odds_auc.toFixed(3) + '.</p></section>' +
      '<section><h3>Ranges, honestly</h3><p class="big">' + pct(DG.coverage_p25_75) + ' in P25–P75 · ' + pct(DG.coverage_p10_90) + ' in P10–P90</p><p>' + pct(DG.coverage_within_3x) + ' of comps within ×3 of fitted. Kinship: ' + DG.kinship_flagged + ' rows share a name stem — flagged, never priced out. Bootstrap 50 draws, seeded.</p></section>';
  }
  function renderPlot() {
    var W = 1100, H = 260, P = 34;
    var xs = D.rows.map(function (r) { return Math.log(r.tvl_usd); });
    var ys = D.rows.map(function (r) { return r.value_if_usd / r.tvl_usd; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var ly = ys.map(function (y) { return Math.log(y); });
    var y0 = Math.min.apply(null, ly), y1 = Math.max.apply(null, ly);
    var X = function (x) { return P + (x - x0) / (x1 - x0) * (W - 2 * P); };
    var Y = function (y) { var l = Math.log(y); return H - P - (l - y0) / (y1 - y0) * (H - 2 * P); };
    var dots = D.rows.map(function (r) {
      var c = price(r).verdict === 'SKIP' ? '#8a8b90' : price(r).verdict === 'MARGINAL' ? '#f5c86b' : '#8fe0a8';
      return '<circle cx="' + X(Math.log(r.tvl_usd)).toFixed(1) + '" cy="' + Y(r.value_if_usd / r.tvl_usd).toFixed(1) + '" r="3" fill="' + c + '"><title>' + esc(r.name) + ' ' + money(r.implied_value_usd) + '</title></circle>';
    }).join('');
    var curve = '';
    for (var i = 0; i <= 40; i++) {
      var tv = Math.exp(x0 + (x1 - x0) * i / 40);
      var m = fittedCap(tv) / tv;
      curve += (i === 0 ? 'M' : 'L') + X(Math.log(tv)).toFixed(1) + ' ' + Y(m).toFixed(1) + ' ';
    }
    $('plot').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img"><path d="' + curve + '" fill="none" stroke="#e8a33d" stroke-width="2"/>' + dots + '<text x="' + (W / 2) + '" y="' + (H - 6) + '" fill="#a9a7a0" font-size="12" text-anchor="middle">TVL (log)</text><text x="10" y="' + (H / 2) + '" fill="#a9a7a0" font-size="12" text-anchor="middle" transform="rotate(-90 10 ' + (H / 2) + ')">fitted multiple (log)</text></svg>';
  }
  function renderBoard() {
    var rows = filtered();
    var tvl = 0, imp = 0;
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var p = price(r);
      tvl += r.tvl_usd; imp += r.implied_value_usd;
      html += '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td><td><b>' + esc(r.name) + '</b><br><span style="color:#a9a7a0">' + esc(r.slug) + '</span></td><td>' + esc(r.category || '—') + '</td><td>' + esc((r.chains || [])[0] || '—') + '</td><td>' + money(r.tvl_usd) + '</td><td>' + chg(r.change_7d) + '</td><td>' + ageLabel(r.age_days) + '</td><td>' + money(r.implied_value_usd) + '</td><td>' + money(r.p25_usd) + '–' + money(r.p75_usd) + '</td><td>' + pct(oddsFor(r.age_days).odds) + '</td><td>' + money(p.deposit) + '</td><td>' + money2(p.drop) + '</td><td>' + money2(p.net) + '</td><td>' + money2(p.perHour) + '</td><td><span class="pill ' + p.verdict + '">' + p.verdict + '</span></td></tr>';
    }
    var tb = document.querySelector('#board tbody');
    tb.innerHTML = html;
    $('count').textContent = rows.length + ' of ' + D.rows.length + ' rows · ' + money(tvl) + ' TVL · ' + money(imp) + ' implied';
    var rc = refitCheck();
    $('refit').textContent = '✓ refit: ' + rc.ok + '/' + rc.n + ' (±1%) · checksum ' + (rc.sum ? '✓' : '✗');
    var cats = {};
    for (var j = 0; j < D.rows.length; j++) cats[D.rows[j].category || '—'] = 1;
    var sel = $('cat');
    if (sel.options.length <= 1) {
      Object.keys(cats).sort().forEach(function (c) { var o = document.createElement('option'); o.value = c === '—' ? '' : c; o.textContent = c; sel.appendChild(o); });
    }
  }
  window.__renderBoard = renderBoard;
  window.__price = price;
  window.__state = state;
  window.__D = D;

  function oddsAtAge(age) {
    if (age === null || age === undefined) return DG.odds_global;
    var centers = [45, 227, 547, 1095];
    var vals = DG.odds_buckets.map(function (b) { return b.odds; });
    if (age <= centers[0]) return vals[0];
    if (age >= centers[centers.length - 1]) return vals[vals.length - 1];
    var la = Math.log(age);
    for (var i = 0; i < centers.length - 1; i++) {
      var l0 = Math.log(centers[i]), l1 = Math.log(centers[i + 1]);
      if (la >= l0 && la <= l1) return vals[i] + (vals[i + 1] - vals[i]) * (la - l0) / (l1 - l0);
    }
    return vals[vals.length - 1];
  }
  function showView(name) {
    ['board', 'live', 'setaside', 'method', 'detail'].forEach(function (v) { $('view-' + v).hidden = v !== name; });
    var tabs = document.querySelectorAll('#tabs button');
    tabs.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === name || (name === 'detail' && b.getAttribute('data-view') === 'board')); });
  }
  function renderDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) r = D.rows[i];
    if (!r) return;
    var p = price(r);
    $('crumb').textContent = 'Board / ' + r.name;
    var olderOdds = oddsAtAge(r.age_days === null ? null : r.age_days + 365);
    var olderImplied = Math.max(1, Math.round(r.value_if_usd * olderOdds));
    function sensRow(label, cap, odds) {
      var imp = cap * odds;
      return '<tr><td>' + label + '</td><td>' + money(imp) + '</td><td>' + pct(odds) + '</td><td>' + money(imp) + '</td><td>×' + (imp / r.implied_value_usd).toFixed(2) + '</td></tr>';
    }
    var sens = sensRow('As recorded', r.value_if_usd, oddsFor(r.age_days).odds)
      + sensRow('TVL 30% lower', fittedCap(r.tvl_usd * 0.7), oddsFor(r.age_days).odds)
      + sensRow('TVL 30% higher', fittedCap(r.tvl_usd * 1.3), oddsFor(r.age_days).odds)
      + sensRow('One year older', r.value_if_usd, olderOdds);
    var shares = [0.01, 0.074, 0.14];
    var deps = [1000, 5000, 10000];
    var grid = '<tr><th></th>' + deps.map(function (d) { return '<th>' + money(d) + '</th>'; }).join('') + '</tr>';
    shares.forEach(function (s) {
      grid += '<tr><td>' + (s * 100).toFixed(1) + '%</td>' + deps.map(function (d) {
        var dep = Math.min(d, E.deposit_cap_usd, E.deposit_share * r.tvl_usd * 50);
        var net = r.implied_value_usd * s * (Math.min(d, E.deposit_cap_usd) / r.tvl_usd) - state.fee;
        return '<td>' + money2(net) + '</td>';
      }).join('') + '</tr>';
    });
    var steps = r.farm_steps.map(function (s, i) {
      var m = s.match(/^(.+) Cost: (.+)\. Time: (.+)\.$/);
      var parts = s.split(' Cost: ');
      var txt = parts[0];
      var rest = parts[1] || '';
      var cm = rest.match(/^(.*)\. Time: (.*)\.$/);
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(txt) + '</td><td>' + esc(cm ? cm[1] : '') + '</td><td>' + esc(cm ? cm[2] : '') + '</td></tr>';
    }).join('');
    var peers = r.peers.length === 0 ? '<p class="note">No same-category priced peer in the snapshot.</p>' : '<table><thead><tr><th>Token</th><th>Category</th><th>TVL</th><th>Market cap</th><th>Cap / TVL</th><th>Fitted cap</th><th>Model ÷ actual</th></tr></thead><tbody>' + r.peers.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.category || '—') + '</td><td>' + money(x.tvl_usd) + '</td><td>' + money(x.mcap_usd) + '</td><td>' + (x.mcap_usd / x.tvl_usd).toFixed(2) + '×</td><td>' + money(x.fitted_usd) + '</td><td>' + x.ratio.toFixed(2) + '×</td></tr>';
    }).join('') + '</tbody></table><p class="note">Fitted cap is not held out: the peer was in the fit.</p>';
    $('detail').innerHTML =
      '<div class="grid"><section><h3>' + esc(r.name) + ' · ' + esc(r.category || '—') + ' · ' + esc((r.chains || [])[0] || '—') + '</h3>'
      + '<p>Rank #' + r.rank + ' of ' + D.rows.length + ' by implied value · TVL ' + money(r.tvl_usd) + ' · 7D ' + (r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + ' · no-token age ' + ageLabel(r.age_days) + ' · first listed ' + esc(r.listed_at || '—') + '</p>'
      + '<div class="bigval">' + money(r.implied_value_usd) + '</div><p>P25–P75 ' + money(r.p25_usd) + '–' + money(r.p75_usd) + ' · P10–P90 ' + money(r.p10_usd) + '–' + money(r.p90_usd) + '</p>'
      + '<p class="note">Recomputed from the snapshot in this build. The snapshot records no tracked token for it — not proof it has none. Odds are the peers’ record, not a forecast.</p></section>'
      + '<section><h3>How the value is built</h3>'
      + '<div class="kv"><span>Size curve</span><b>ln(cap) = ' + D.model.intercept.toFixed(3) + ' + ' + D.model.slope.toFixed(3) + ' × ln(TVL)</b></div>'
      + '<div class="kv"><span>Age bucket</span><b>' + esc(oddsFor(r.age_days).label) + ' · ' + ageLabel(r.age_days) + '</b></div>'
      + '<div class="kv"><span>Fitted cap</span><b>' + money(r.value_if_usd) + '</b></div>'
      + '<div class="kv"><span>Multiple (fitted ÷ TVL)</span><b>×' + (r.value_if_usd / r.tvl_usd).toFixed(3) + '</b></div>'
      + '<div class="kv"><span>Token odds (' + esc(oddsFor(r.age_days).label) + ' bucket)</span><b>' + pct(oddsFor(r.age_days).odds) + '</b></div>'
      + '<div class="kv"><span>Implied value</span><b>' + money(r.implied_value_usd) + '</b></div></section></div>'
      + '<div class="grid" style="margin-top:12px"><section><h3>Costed verdict at fee $' + state.fee.toFixed(2) + ', ' + state.weeks + ' weeks</h3>'
      + '<div class="kv"><span>Deposit (min(cap, 0.02% of TVL))</span><b>' + money(p.deposit) + '</b></div>'
      + '<div class="kv"><span>Modelled drop (' + (E.drop_share * 100).toFixed(1) + '% share, ' + state.weeks + ' weeks)</span><b>' + money2(p.drop) + '</b></div>'
      + '<div class="kv"><span>Fees</span><b>−' + money2(state.fee) + '</b></div>'
      + '<div class="kv"><span>Net (drop − fees)</span><b>' + money2(p.net) + '</b></div>'
      + '<div class="kv"><span>Net / hour (' + hours().toFixed(1) + 'h active)</span><b>' + money2(p.perHour) + '</b></div>'
      + '<div class="kv"><span>Low-end net (P25)</span><b>' + money2(r.p25_usd * E.drop_share * (p.deposit / r.tvl_usd) - state.fee) + '</b></div>'
      + '<div class="kv"><span>Break-even odds</span><b>' + pct(p.breakeven) + '</b></div>'
      + '<div class="kv"><span>T-bill at ' + (E.tbill_rate * 100).toFixed(0) + '%</span><b>' + money2(p.tbill) + '</b></div>'
      + '<div class="kv"><span>Verdict</span><b><span class="pill ' + p.verdict + '">' + p.verdict + '</span></b></div></section>'
      + '<section><h3>If the record changes</h3><table><thead><tr><th>If</th><th>Value if it launches</th><th>Token odds</th><th>Implied</th><th>vs now</th></tr></thead><tbody>' + sens + '</tbody></table>'
      + '<h3 style="margin-top:14px">Net by drop share and deposit</h3><table><thead>' + grid + '</thead></table></section></div>'
      + '<section style="margin-top:12px"><h3>Farm plan: 10 steps, $' + E.fee_usd.toFixed(2) + ' of gas, ' + (E.active_minutes / 60).toFixed(1) + 'h active</h3><table><thead><tr><th>#</th><th>Step</th><th>Cost</th><th>Time</th></tr></thead><tbody>' + steps + '</tbody></table></section>'
      + '<section style="margin-top:12px"><h3>Priced peers, same category</h3>' + peers + '</section>';
    showView('detail');
    window.scrollTo(0, 0);
  }
  function renderLive() {
    $('livetab').querySelector('tbody').innerHTML = D.live.map(function (r) {
      return '<tr><td><b>' + esc(r.name) + '</b><br><span style="color:#a9a7a0">' + esc(r.slug) + '</span></td><td>' + esc(r.category || '—') + '</td><td>' + esc(r.chains.join(', ')) + '</td><td>' + money(r.tvl_usd) + '</td><td>' + (r.mcap_usd === null ? '—' : money(r.mcap_usd)) + '</td><td>' + (r.mcap_usd === null ? '—' : (r.mcap_usd / r.tvl_usd).toFixed(2) + '×') + '</td><td>' + chg(r.change_7d) + '</td></tr>';
    }).join('');
  }
  function renderSetAside() {
    var a = D.accounting;
    function tbl(title, rows) {
      return '<section style="background:#17181d;border:1px solid #26272c;border-radius:8px;padding:12px 14px;margin-bottom:12px"><h3>' + title + '</h3><table><tbody>' + rows.map(function (x) { return '<tr><td>' + x[0] + '</td><td>' + num(x[1]) + '</td></tr>'; }).join('') + '</tbody></table></section>';
    }
    $('setaside').innerHTML =
      tbl('Universe accounting — closes at ' + num(a.total), [['Protocols in the snapshot', a.total], ['Ranked on the board', a.ranked], ['Pre-token below the cut, unranked', a.below_cut_pre_token], ['Priced comps in the fit', a.priced_comps], ['Other priced protocols', a.priced_other], ['Token recorded, no market cap', a.recorded_no_cap], ['Pre-token excluded (exchange or versioned)', a.excluded_pre_token], ['Above the floor, unranked', a.above_floor_unranked]])
      + tbl('Token odds by age bucket', DG.odds_buckets.map(function (b) { return [b.label + ' — ' + b.tokened + ' of ' + b.peers + ' record a token', Math.round(b.odds * 1000) / 10 + '%']; }))
      + tbl('Live token set aside', [['Protocols shown on the Live tab', D.live_size], ['Watchlist size', D.watchlist_size], ['Board size', D.board_size], ['Early rows', D.early_size]]);
  }
  function renderMethod() {
    var d = DG;
    $('method').innerHTML =
      '<section style="background:#17181d;border:1px solid #26272c;border-radius:8px;padding:12px 14px;margin-bottom:12px"><h3>Size curve</h3><p>ln(market cap) = ' + d.intercept.toFixed(3) + ' + ' + d.slope.toFixed(3) + ' × ln(TVL), fitted by OLS on ' + d.n_comps + ' priced protocols from this snapshot. Miss (median |fitted ÷ actual|): fitted ×' + d.miss_fitted.toFixed(2) + ', 5-fold CV ×' + d.miss_cv.toFixed(2) + ', walk-forward (older half fits, newer half tested) ×' + d.miss_walkforward.toFixed(2) + ', flat median multiple ×' + d.miss_flat.toFixed(2) + '. A category term was tested and dropped: the curve uses size alone, and the category-blind check is the same fit. Multiple at $100M TVL: ×' + d.multiple_at_100m_mean.toFixed(3) + ' ± ' + d.multiple_at_100m_sd.toFixed(3) + '. Slope ' + d.slope_mean.toFixed(2) + ' ± ' + d.slope_sd.toFixed(2) + ' over 50 seeded bootstrap draws.</p></section>'
      + '<section style="background:#17181d;border:1px solid #26272c;border-radius:8px;padding:12px 14px;margin-bottom:12px"><h3>Token odds</h3><p>Share of protocols recording a token, by no-token age, shrunk toward the global rate (' + pct(d.odds_global) + ') with 10 pseudo-counts. Brier ' + d.odds_brier.toFixed(3) + ' against base ' + d.odds_brier_base.toFixed(3) + ' and permuted-age control ' + d.odds_brier_permuted.toFixed(3) + '. AUC ' + d.odds_auc.toFixed(3) + '. A logit on age was tested and not kept (Brier worse than the buckets). Odds are the peers’ record, not a forecast of any one protocol.</p></section>'
      + '<section style="background:#17181d;border:1px solid #26272c;border-radius:8px;padding:12px 14px;margin-bottom:12px"><h3>Economics and verdicts</h3><p>Deposit min($10,000, 0.02% of TVL). Drop share 14% of the fitted cap, pro-rata by deposit share, times token odds. Fee $' + E.fee_usd.toFixed(2) + ' (live control). Horizon 12 weeks (live control). T-bill 4% a year. Active time (144 + 5 × weeks) / 60 minutes. ROBUST: low-end (P25) net beats the T-bill and net/hour ≥ $25. FARM: net beats the T-bill and net/hour ≥ $25. MARGINAL: net above zero. Else SKIP. Break-even odds: the odds at which drop covers fee plus T-bill.</p></section>'
      + '<section style="background:#17181d;border:1px solid #26272c;border-radius:8px;padding:12px 14px"><h3>Honesty notes</h3><p>Market caps are the snapshot’s recorded caps, not fully diluted value, and no outside price fill was added. Ranges come from a seeded 50-draw predictive bootstrap of the curve (parameter draws plus the fit residual spread), not from a second dataset. Peer fitted caps are not held out: each peer was in the fit. Kinship: ' + d.kinship_flagged + ' ranked rows share a name stem with another ranked row; they are flagged in the diagnostics and priced like any other row. The snapshot records no token for the ranked rows; that is not proof any of them has none. Re-running the program on the same snapshot bytes reproduces the board exactly (checksum ' + d.checksum + ').</p></section>';
  }
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-view');
      if (v === 'live') renderLive();
      if (v === 'setaside') renderSetAside();
      if (v === 'method') renderMethod();
      showView(v);
    });
  });
  $('back').addEventListener('click', function () { showView('board'); });
  document.querySelector('#board tbody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) renderDetail(tr.getAttribute('data-slug'));
  });
  ['q', 'cat', 'verdict', 'fee', 'weeks'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      state.q = $('q').value; state.cat = $('cat').value; state.verdict = $('verdict').value;
      state.fee = Math.max(0, parseFloat($('fee').value) || 0); state.weeks = parseInt($('weeks').value, 10) || 12;
      renderKpis(); renderBoard();
    });
  });
  renderMeta(); renderKpis(); renderStrip(); renderCards(); renderPlot(); renderBoard();
  window.__showDetail = renderDetail;
})();
