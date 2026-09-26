/*
 * 字幕解析层。纯函数，无副作用，可在 node 里单跑。
 * 覆盖四种常见形态：WebVTT / SRT、TTML(DFXP)、通用 JSON（含 YouTube json3）。
 * 统一输出 [{ start: 秒, end: 秒, text: string }]
 */

var DS_PARSE = (function () {

  function dsParseTimecode(v) {
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim();
    if (!s) return NaN;

    var off = s.match(/^(-?[\d.]+)\s*(ms|s|m|h|f|t)$/i);
    if (off) {
      var n = parseFloat(off[1]);
      if (!isFinite(n)) return NaN;
      var u = off[2].toLowerCase();
      if (u === 'ms') return n / 1000;
      if (u === 's') return n;
      if (u === 'm') return n * 60;
      if (u === 'h') return n * 3600;
      if (u === 'f') return n / 25;
      if (u === 't') return n / 10000;
      return NaN;
    }

    var norm = s.replace(/\s+/g, '').replace(',', '.');
    var parts = norm.split(':');
    if (parts.length === 4) parts = parts.slice(0, 3);
    if (parts.length > 3) return NaN;
    var sec = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parseFloat(parts[i]);
      if (!isFinite(p)) return NaN;
      sec = sec * 60 + p;
    }
    return sec;
  }

  function dsCleanCueText(t) {
    var s = String(t === null || t === undefined ? '' : t);
    s = s.replace(/<[^>]*>/g, ' ');
    s = s.replace(/\{\\[^}]*\}/g, ' ');
    s = s.replace(/\\[Nnh]\b/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, '&');
    return s.replace(/\s+/g, ' ').trim();
  }

  function dsParseVTT(text) {
    var out = [];
    var src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var blocks = src.split(/\n{2,}/);

    for (var i = 0; i < blocks.length; i++) {
      var clean = [];
      var raw = blocks[i].split('\n');
      for (var j = 0; j < raw.length; j++) {
        if (raw[j].trim() !== '') clean.push(raw[j]);
      }
      if (!clean.length) continue;
      if (/^\s*WEBVTT/i.test(clean[0])) {
        clean.shift();
        if (!clean.length) continue;
      }
      if (/^\s*(NOTE|STYLE|REGION)\b/i.test(clean[0])) continue;

      var guard = 0;
      while (clean.length > 1 && clean[0].indexOf('-->') < 0 && guard++ < 3) {
        clean.shift();
      }

      var line0 = clean[0] || '';
      var arrow = line0.indexOf('-->');
      if (arrow < 0) continue;

      var start = dsParseTimecode(line0.slice(0, arrow));
      var right = line0.slice(arrow + 3).trim().split(/\s+/)[0];
      var end = dsParseTimecode(right);
      var body = dsCleanCueText(clean.slice(1).join('\n'));
      if (!isFinite(start) || !body) continue;

      out.push({ start: start, end: isFinite(end) ? end : NaN, text: body });
    }
    return out;
  }

  function dsInheritedBegin(el) {
    var sum = 0, found = false, n = el.parentNode, guard = 0;
    while (n && n.getAttribute && guard++ < 20) {
      var b = dsParseTimecode(n.getAttribute('begin'));
      if (isFinite(b)) { sum += b; found = true; }
      n = n.parentNode;
    }
    return found ? sum : NaN;
  }

  function dsParseTTML(text) {
    var out = [];
    if (typeof DOMParser === 'undefined') return out;
    var doc;
    try { doc = new DOMParser().parseFromString(String(text), 'text/xml'); } catch (e) { return out; }
    if (!doc || doc.getElementsByTagName('parsererror').length) return out;

    var ps = doc.getElementsByTagName('p');
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      var start = dsParseTimecode(p.getAttribute('begin'));
      var eAttr = p.getAttribute('end');
      var end = eAttr ? dsParseTimecode(eAttr) : NaN;
      if (!isFinite(end)) {
        var dur = dsParseTimecode(p.getAttribute('dur'));
        if (isFinite(dur) && isFinite(start)) end = start + dur;
      }
      if (!isFinite(start)) {
        var off = dsInheritedBegin(p);
        if (isFinite(off)) {
          start = off;
          if (isFinite(end)) end = end + off;
        }
      }
      var body = dsCleanCueText(p.textContent || '');
      if (!isFinite(start) || !body) continue;
      out.push({ start: start, end: end, text: body });
    }
    return out;
  }

  function dsPickField(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = obj[k];
      if (typeof v === 'number' && isFinite(v)) return { v: v, ms: /ms$/i.test(k) };
      if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
        return { v: parseFloat(v), ms: /ms$/i.test(k) };
      }
    }
    return null;
  }

  function dsToSeconds(p) {
    if (!p) return NaN;
    var v = p.v;
    if (p.ms) return v / 1000;
    if (Math.abs(v) > 86400) return v / 1000;
    return v;
  }

  var START_KEYS = ['start', 'from', 'begin', 'startTime', 'start_time', 'startMs', 'tStartMs', 'offset'];
  var END_KEYS = ['end', 'to', 'endTime', 'end_time', 'endMs', 'tEndMs'];
  var DUR_KEYS = ['duration', 'dur', 'dDurationMs', 'length', 'len'];
  var TEXT_KEYS = ['text', 'content', 'body', 'caption', 'subtitle', 'captionText', 'value', 'line', 'sentence'];

  function dsParseJSON(text) {
    var out = [];
    var j;
    try { j = JSON.parse(String(text)); } catch (e) { return out; }

    if (j && Array.isArray(j.events)) {
      for (var i = 0; i < j.events.length; i++) {
        var e = j.events[i];
        if (!e || !Array.isArray(e.segs)) continue;
        var joined = '';
        for (var s = 0; s < e.segs.length; s++) {
          joined += (e.segs[s] && e.segs[s].utf8) || '';
        }
        var txt = dsCleanCueText(joined);
        if (!txt) continue;
        var st = (Number(e.tStartMs) || 0) / 1000;
        var du = (Number(e.dDurationMs) || 0) / 1000;
        out.push({ start: st, end: du ? st + du : NaN, text: txt });
      }
      return out;
    }

    var arr = null;
    if (Array.isArray(j)) {
      arr = j;
    } else if (j && typeof j === 'object') {
      var bags = ['body', 'cues', 'subtitles', 'captions', 'data', 'lines', 'items', 'list', 'result', 'results', 'sentences', 'segments'];
      for (var b = 0; b < bags.length; b++) {
        if (Array.isArray(j[bags[b]])) { arr = j[bags[b]]; break; }
      }
    }
    if (!arr) return out;

    for (var n = 0; n < arr.length; n++) {
      var it = arr[n];
      if (!it || typeof it !== 'object') continue;

      var start = dsToSeconds(dsPickField(it, START_KEYS));
      if (!isFinite(start)) continue;

      var end = dsToSeconds(dsPickField(it, END_KEYS));
      if (!isFinite(end)) {
        var d = dsToSeconds(dsPickField(it, DUR_KEYS));
        if (isFinite(d)) end = start + d;
      }

      var txtRaw = null;
      for (var tk = 0; tk < TEXT_KEYS.length; tk++) {
        if (typeof it[TEXT_KEYS[tk]] === 'string') { txtRaw = it[TEXT_KEYS[tk]]; break; }
      }
      if (txtRaw === null && Array.isArray(it.segs)) {
        txtRaw = it.segs.map(function (x) { return (x && x.utf8) || ''; }).join('');
      }
      if (txtRaw === null && Array.isArray(it.words)) {
        txtRaw = it.words.map(function (x) { return (x && (x.word || x.text)) || ''; }).join('');
      }
      if (txtRaw === null) continue;

      var body = dsCleanCueText(txtRaw);
      if (!body) continue;

      out.push({ start: start, end: end, text: body });
    }
    return out;
  }

  function dsNormalizeCues(cues) {
    var list = [];
    if (!cues || !cues.length) return list;

    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c || typeof c.start !== 'number' || !isFinite(c.start)) continue;
      var body = dsCleanCueText(c.text);
      if (!body || body.length > 400) continue;
      if (body.indexOf('-->') >= 0) continue;
      list.push({ start: c.start, end: typeof c.end === 'number' ? c.end : NaN, text: body });
    }

    list.sort(function (a, b) { return a.start - b.start; });

    for (var j = 0; j < list.length; j++) {
      if (!isFinite(list[j].end) || list[j].end <= list[j].start) {
        var nxt = list[j + 1];
        list[j].end = nxt ? Math.max(list[j].start + 0.6, nxt.start) : list[j].start + 3;
      }
    }

    var out = [];
    for (var k = 0; k < list.length; k++) {
      var prev = out[out.length - 1];
      if (prev && prev.text === list[k].text && list[k].start - prev.end < 0.35) {
        prev.end = Math.max(prev.end, list[k].end);
        continue;
      }
      out.push(list[k]);
    }
    return out;
  }

  function dsParseSubtitle(text, url) {
    var t = String(text || '');
    if (t.length < 4) return { format: 'none', cues: [] };
    var head = t.slice(0, 2000);
    var cues = [];
    var format = 'unknown';

    if (/^\uFEFF?\s*WEBVTT/i.test(head) || head.indexOf('-->') >= 0) {
      cues = dsParseVTT(t);
      if (cues.length) format = 'vtt';
    }
    if (!cues.length && (/^\s*</.test(head) || /<tt[\s:>]/i.test(head))) {
      cues = dsParseTTML(t);
      if (cues.length) format = 'ttml';
    }
    if (!cues.length && /^\s*[\[{]/.test(head)) {
      cues = dsParseJSON(t);
      if (cues.length) format = 'json';
    }
    if (!cues.length) {
      cues = dsParseJSON(t);
      if (cues.length) format = 'auto-json';
      if (!cues.length) { cues = dsParseTTML(t); if (cues.length) format = 'auto-ttml'; }
      if (!cues.length) { cues = dsParseVTT(t); if (cues.length) format = 'auto-vtt'; }
    }
    return { format: format, cues: dsNormalizeCues(cues) };
  }

  function dsCueAt(cues, t) {
    if (!cues || !cues.length) return null;
    var lo = 0, hi = cues.length - 1, ans = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= t + 0.001) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans === null) return null;
    for (var step = 0; ans >= 0 && step < 6; step++, ans--) {
      if (cues[ans].start <= t + 0.001 && cues[ans].end >= t - 0.001) return cues[ans];
    }
    return null;
  }

  return {
    parseTimecode: dsParseTimecode,
    cleanCueText: dsCleanCueText,
    parseVTT: dsParseVTT,
    parseTTML: dsParseTTML,
    parseJSON: dsParseJSON,
    normalizeCues: dsNormalizeCues,
    parseSubtitle: dsParseSubtitle,
    cueAt: dsCueAt
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DS_PARSE;
}
