/* Section Looper — loop a chosen range of a YouTube video.
   Vanilla JS, no build step. Uses the YouTube IFrame Player API. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    form: $('loadForm'), url: $('urlInput'), status: $('status'),
    controls: $('controls'), track: $('track'), region: $('region'),
    hStart: $('handleStart'), hEnd: $('handleEnd'), playhead: $('playhead'),
    startLabel: $('startLabel'), endLabel: $('endLabel'), nowLabel: $('nowLabel'),
    playBtn: $('playBtn'), iconPlay: $('iconPlay'), iconPause: $('iconPause'),
    restartBtn: $('restartBtn'), speed: $('speed'),
    startInput: $('startInput'), endInput: $('endInput'),
    shareBtn: $('shareBtn'), shareMsg: $('shareMsg')
  };

  var MIN_LOOP = 0.2;       // seconds; smallest allowed loop
  var END_EPSILON = 0.06;   // jump back this far before the end so we never overshoot
  var TICK_MS = 40;

  var state = {
    videoId: null,
    duration: 0,
    start: 0,
    end: 0,
    playing: false,
    apiReady: false,
    player: null,
    pendingLoad: null,   // {videoId, start, end} waiting for API
    ticker: null
  };

  /* ---------- helpers ---------- */

  function parseVideoId(text) {
    if (!text) return null;
    text = text.trim();
    if (/^[\w-]{11}$/.test(text)) return text;
    var m;
    try {
      var u = new URL(text.indexOf('http') === 0 ? text : 'https://' + text);
      var host = u.hostname.replace(/^www\.|^m\./, '');
      if (host === 'youtu.be') {
        m = u.pathname.slice(1).match(/^[\w-]{11}/);
        return m ? m[0] : null;
      }
      if (/youtube(-nocookie)?\.com$/.test(host)) {
        var v = u.searchParams.get('v');
        if (v && /^[\w-]{11}$/.test(v)) return v;
        m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        if (m) return m[1];
      }
    } catch (e) { /* not a URL */ }
    m = text.match(/(?:v=|\/)([\w-]{11})(?:[?&#/]|$)/);
    return m ? m[1] : null;
  }

  function fmt(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    var sStr = s.toFixed(1);
    if (s < 10) sStr = '0' + sStr;
    return m + ':' + sStr;
  }

  function parseTime(str) {
    if (str == null) return NaN;
    str = String(str).trim();
    if (!str) return NaN;
    var parts = str.split(':');
    if (parts.length > 3) return NaN;
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var n = parseFloat(parts[i]);
      if (isNaN(n)) return NaN;
      total = total * 60 + n;
    }
    return total;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function setStatus(msg, isError) {
    el.status.textContent = msg;
    el.status.classList.toggle('error', !!isError);
  }

  function currentTime() {
    try { return state.player && state.player.getCurrentTime ? state.player.getCurrentTime() : 0; }
    catch (e) { return 0; }
  }

  /* ---------- loop range ---------- */

  function setRange(start, end, opts) {
    opts = opts || {};
    var dur = state.duration || Math.max(end, start + MIN_LOOP);
    start = clamp(start, 0, Math.max(0, dur - MIN_LOOP));
    end = clamp(end, start + MIN_LOOP, dur);
    state.start = start;
    state.end = end;
    render();
    if (!opts.silent) persist();
  }

  function shiftRange(delta) {
    var len = state.end - state.start;
    var start = clamp(state.start + delta, 0, state.duration - len);
    setRange(start, start + len);
  }

  function render() {
    var dur = state.duration || 1;
    var l = (state.start / dur) * 100;
    var w = ((state.end - state.start) / dur) * 100;
    el.region.style.left = l + '%';
    el.region.style.width = w + '%';
    el.startLabel.textContent = fmt(state.start);
    el.endLabel.textContent = fmt(state.end);
    if (document.activeElement !== el.startInput) el.startInput.value = fmt(state.start);
    if (document.activeElement !== el.endInput) el.endInput.value = fmt(state.end);
    el.hStart.setAttribute('aria-valuenow', state.start.toFixed(1));
    el.hEnd.setAttribute('aria-valuenow', state.end.toFixed(1));
    el.hStart.setAttribute('aria-valuemax', dur.toFixed(1));
    el.hEnd.setAttribute('aria-valuemax', dur.toFixed(1));
    renderPlayhead(currentTime());
  }

  function renderPlayhead(t) {
    var dur = state.duration || 1;
    el.playhead.style.left = clamp((t / dur) * 100, 0, 100) + '%';
    el.nowLabel.textContent = fmt(t);
  }

  /* ---------- persistence / sharing ---------- */

  function persist() {
    if (!state.videoId) return;
    var data = { v: state.videoId, s: round1(state.start), e: round1(state.end) };
    try { localStorage.setItem('looper:last', JSON.stringify(data)); } catch (e) { /* ignore */ }
    var hash = '#v=' + data.v + '&s=' + data.s + '&e=' + data.e;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  function readSaved() {
    var h = location.hash.replace(/^#/, '');
    if (h) {
      var p = new URLSearchParams(h);
      var v = p.get('v');
      if (v && /^[\w-]{11}$/.test(v)) {
        return { v: v, s: parseFloat(p.get('s')), e: parseFloat(p.get('e')) };
      }
    }
    try {
      var raw = localStorage.getItem('looper:last');
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------- YouTube player ---------- */

  function loadApi() {
    if (window.YT && window.YT.Player) { onApiReady(); return; }
    window.onYouTubeIframeAPIReady = onApiReady;
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    document.head.appendChild(s);
  }

  function onApiReady() {
    state.apiReady = true;
    if (state.pendingLoad) {
      var p = state.pendingLoad; state.pendingLoad = null;
      loadVideo(p.videoId, p.start, p.end);
    }
  }

  function loadVideo(videoId, start, end) {
    if (!state.apiReady) {
      state.pendingLoad = { videoId: videoId, start: start, end: end };
      setStatus('Loading player…');
      return;
    }
    stopTicker();
    state.videoId = videoId;
    state.duration = 0;
    state.playing = false;
    state.requestedStart = isFinite(start) ? start : 0;
    state.requestedEnd = isFinite(end) ? end : NaN;
    updatePlayIcon();
    setStatus('Loading video…');

    if (state.player) {
      state.player.cueVideoById({ videoId: videoId });
      return;
    }
    state.player = new YT.Player('player', {
      videoId: videoId,
      playerVars: {
        playsinline: 1,     // iOS: play inline instead of fullscreen
        rel: 0,
        modestbranding: 1,
        controls: 1,
        enablejsapi: 1,
        origin: location.origin
      },
      events: {
        onReady: function () { tryInitDuration(); },
        onStateChange: onPlayerState,
        onError: function (e) {
          var msgs = { 2: 'That does not look like a valid video ID.', 5: 'This video cannot be played here.',
                       100: 'Video not found (private or removed).', 101: 'The owner has disabled embedding for this video.',
                       150: 'The owner has disabled embedding for this video.' };
          setStatus(msgs[e.data] || 'Could not load that video.', true);
        }
      }
    });
  }

  function tryInitDuration() {
    var d = 0;
    try { d = state.player.getDuration(); } catch (e) { d = 0; }
    if (!d || d <= 0) return false;
    if (state.duration === 0) {
      state.duration = d;
      var s = clamp(state.requestedStart || 0, 0, d - MIN_LOOP);
      var e = isFinite(state.requestedEnd) ? state.requestedEnd : Math.min(d, s + 10);
      setRange(s, e);
      el.controls.hidden = false;
      setStatus('Ready. Drag the range, then press play.');
      try { state.player.seekTo(state.start, true); } catch (err) { /* ignore */ }
    }
    return true;
  }

  function onPlayerState(ev) {
    var YTS = window.YT.PlayerState;
    if (ev.data === YTS.CUED || ev.data === YTS.PLAYING || ev.data === YTS.PAUSED || ev.data === YTS.BUFFERING) {
      tryInitDuration();
    }
    if (ev.data === YTS.PLAYING) {
      state.playing = true;
      startTicker();
    } else if (ev.data === YTS.PAUSED || ev.data === YTS.ENDED) {
      state.playing = false;
      stopTicker();
      if (ev.data === YTS.ENDED) {
        // Video ran off the end (loop end == duration): restart the loop.
        state.player.seekTo(state.start, true);
        state.player.playVideo();
      }
    }
    updatePlayIcon();
  }

  function startTicker() {
    stopTicker();
    state.ticker = setInterval(tick, TICK_MS);
  }
  function stopTicker() {
    if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
  }

  function tick() {
    if (!state.player || !state.duration) { tryInitDuration(); return; }
    var t = currentTime();
    // Jump back when we hit the end, or when playback wandered outside the loop
    // (e.g. the user scrubbed the YouTube bar, or dragged the loop somewhere else).
    if (t >= state.end - END_EPSILON || t < state.start - 0.5) {
      state.player.seekTo(state.start, true);
      t = state.start;
    }
    renderPlayhead(t);
  }

  function updatePlayIcon() {
    // SVG elements have no .hidden property, so toggle the attribute.
    if (state.playing) { el.iconPlay.setAttribute('hidden', ''); el.iconPause.removeAttribute('hidden'); }
    else { el.iconPause.setAttribute('hidden', ''); el.iconPlay.removeAttribute('hidden'); }
    el.playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  }

  function play() {
    if (!state.player || !state.duration) return;
    var t = currentTime();
    if (t < state.start || t >= state.end - END_EPSILON) {
      state.player.seekTo(state.start, true);
    }
    state.player.playVideo();
  }
  function pause() { if (state.player) state.player.pauseVideo(); }
  function togglePlay() { state.playing ? pause() : play(); }

  function restart() {
    if (!state.player || !state.duration) return;
    state.player.seekTo(state.start, true);
    renderPlayhead(state.start);
    if (!state.playing) state.player.playVideo();
  }

  /* ---------- drag handling (mouse + touch via Pointer Events) ---------- */

  var drag = null; // { mode: 'start'|'end'|'move', startX, origStart, origEnd }

  function timeAtX(clientX) {
    var r = el.track.getBoundingClientRect();
    var frac = clamp((clientX - r.left) / r.width, 0, 1);
    return frac * state.duration;
  }

  // Decide what a press on the track means. Hit zones are measured in pixels so
  // they stay usable even when the loop region is only a few pixels wide.
  var EDGE_OUT = 22, EDGE_IN = 10;
  function hitMode(clientX) {
    var r = el.track.getBoundingClientRect();
    var x = clientX - r.left;
    var sx = (state.start / state.duration) * r.width;
    var ex = (state.end / state.duration) * r.width;
    var width = ex - sx;
    var nearStart = x >= sx - EDGE_OUT && x <= sx + Math.min(EDGE_IN, width / 3);
    var nearEnd = x <= ex + EDGE_OUT && x >= ex - Math.min(EDGE_IN, width / 3);
    if (nearStart && nearEnd) return (x - sx < ex - x) ? 'start' : 'end';
    if (nearStart) return 'start';
    if (nearEnd) return 'end';
    if (x > sx && x < ex) return 'move';
    return null;
  }

  function onPointerDown(e) {
    if (!state.duration) return;
    var mode = hitMode(e.clientX);
    if (!mode) {
      // Tap on the bare track: move the loop so it starts there, and seek to it.
      var t = timeAtX(e.clientX);
      var len = state.end - state.start;
      var s = clamp(t, 0, state.duration - len);
      setRange(s, s + len);
      if (state.player) { state.player.seekTo(state.start, true); renderPlayhead(state.start); }
      return;
    }
    e.preventDefault();
    drag = { mode: mode, startX: e.clientX, origStart: state.start, origEnd: state.end, pointerId: e.pointerId };
    el.region.classList.add('dragging');
    try { el.track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    var r = el.track.getBoundingClientRect();
    var dt = ((e.clientX - drag.startX) / r.width) * state.duration;
    if (drag.mode === 'start') {
      setRange(clamp(drag.origStart + dt, 0, drag.origEnd - MIN_LOOP), drag.origEnd, { silent: true });
    } else if (drag.mode === 'end') {
      setRange(drag.origStart, clamp(drag.origEnd + dt, drag.origStart + MIN_LOOP, state.duration), { silent: true });
    } else {
      var len = drag.origEnd - drag.origStart;
      var s = clamp(drag.origStart + dt, 0, state.duration - len);
      setRange(s, s + len, { silent: true });
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    el.region.classList.remove('dragging');
    try { el.track.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    persist();
    // If the playhead is now outside the new loop, jump into it immediately.
    if (state.playing) {
      var t = currentTime();
      if (t < state.start || t >= state.end - END_EPSILON) {
        state.player.seekTo(state.start, true);
        renderPlayhead(state.start);
      }
    }
  }

  el.track.addEventListener('pointerdown', onPointerDown);
  el.track.addEventListener('pointermove', onPointerMove);
  el.track.addEventListener('pointerup', onPointerUp);
  el.track.addEventListener('pointercancel', onPointerUp);

  /* ---------- keyboard on handles ---------- */

  function handleKeys(edge) {
    return function (e) {
      var step = e.shiftKey ? 1 : 0.1;
      var delta = 0;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step;
      else return;
      e.preventDefault();
      nudge(edge, delta);
    };
  }
  el.hStart.addEventListener('keydown', handleKeys('start'));
  el.hEnd.addEventListener('keydown', handleKeys('end'));

  function nudge(edge, delta) {
    if (edge === 'start') setRange(state.start + delta, state.end);
    else setRange(state.start, state.end + delta);
  }

  /* ---------- fine-tune buttons & inputs ---------- */

  document.querySelectorAll('.fine button[data-edge]').forEach(function (b) {
    b.addEventListener('click', function () {
      nudge(b.getAttribute('data-edge'), parseFloat(b.getAttribute('data-delta')));
    });
  });

  function bindTimeInput(input, edge) {
    function commit() {
      var t = parseTime(input.value);
      if (isNaN(t)) { render(); return; }
      nudge(edge, t - (edge === 'start' ? state.start : state.end));
      input.blur();
    }
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    input.addEventListener('blur', render);
  }
  bindTimeInput(el.startInput, 'start');
  bindTimeInput(el.endInput, 'end');

  /* ---------- transport ---------- */

  el.playBtn.addEventListener('click', togglePlay);
  el.restartBtn.addEventListener('click', restart);
  el.speed.addEventListener('change', function () {
    if (state.player) state.player.setPlaybackRate(parseFloat(el.speed.value));
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Enter' && e.target === document.body) { restart(); }
    else if (e.key === '[' ) { shiftRange(-(e.shiftKey ? 1 : 0.1)); }
    else if (e.key === ']' ) { shiftRange(e.shiftKey ? 1 : 0.1); }
  });

  /* ---------- share ---------- */

  el.shareBtn.addEventListener('click', function () {
    persist();
    var url = location.href;
    function done(ok) {
      el.shareMsg.textContent = ok ? 'Copied!' : url;
      setTimeout(function () { el.shareMsg.textContent = ''; }, 3000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  });

  /* ---------- load form ---------- */

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = parseVideoId(el.url.value);
    if (!id) { setStatus('Could not find a YouTube video ID in that link.', true); return; }
    el.url.blur();
    loadVideo(id, 0, NaN);
  });

  /* ---------- boot ---------- */

  var saved = readSaved();
  loadApi();
  if (saved && saved.v) {
    el.url.value = 'https://youtu.be/' + saved.v;
    loadVideo(saved.v, saved.s, saved.e);
  }

  // Expose a tiny debug/test surface.
  window.__looper = { state: state, parseVideoId: parseVideoId, parseTime: parseTime, fmt: fmt, setRange: setRange };
})();
