/*! MotionForge runtime - scroll-controlled canvas animation.
 *  Dependencies: none. Network access: none (only loads the image URLs you give it).
 *  Reads a validated JSON scene; it never evaluates code from the scene. */
(function (g) {
  'use strict';
  var PI = Math.PI;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var easings = {
    linear: function (t) { return t; },
    easeIn: function (t) { return t * t; },
    easeOut: function (t) { return 1 - (1 - t) * (1 - t); },
    easeInOut: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    cinematic: function (t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  };

  // Evenly spaced values across 0..1, linearly interpolated.
  function sampleArray(a, t) {
    if (!a || !a.length) return 0;
    if (a.length === 1) return a[0];
    var f = clamp(t, 0, 1) * (a.length - 1);
    var i = Math.min(Math.floor(f), a.length - 2);
    return a[i] + (a[i + 1] - a[i]) * (f - i);
  }

  function crom(a, b, c, d, u) {
    return 0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  }

  // Catmull-Rom curve through keyframes ({progress, x, y}); x/y are % of the stage.
  function samplePath(path, t) {
    var p = path.slice().sort(function (a, b) { return a.progress - b.progress; });
    var n = p.length;
    if (t <= p[0].progress) return { x: p[0].x, y: p[0].y };
    if (t >= p[n - 1].progress) return { x: p[n - 1].x, y: p[n - 1].y };
    var i = 0;
    while (i < n - 2 && t > p[i + 1].progress) i++;
    var p0 = p[Math.max(i - 1, 0)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(i + 2, n - 1)];
    var span = p2.progress - p1.progress;
    var u = span > 0 ? (t - p1.progress) / span : 0;
    return { x: crom(p0.x, p1.x, p2.x, p3.x, u), y: crom(p0.y, p1.y, p2.y, p3.y, u) };
  }

  // Pure function of (object, progress): the same progress always gives the same pose,
  // which is what makes scrolling backwards exactly reverse the animation.
  function evaluate(obj, progress) {
    var span = obj.end - obj.start;
    var raw = span > 0 ? clamp((progress - obj.start) / span, 0, 1) : 0;
    var ease = easings[obj.easing] || easings.linear;
    var t = ease(raw);
    var pos = obj.pinned ? { x: obj.path[0].x, y: obj.path[0].y } : samplePath(obj.path, t);
    var tilt = 0;
    if (obj.followPath && !obj.pinned) {
      var a = samplePath(obj.path, clamp(t + 0.01, 0, 1));
      var b = samplePath(obj.path, clamp(t - 0.01, 0, 1));
      tilt = clamp(Math.atan2(a.y - b.y, a.x - b.x) * 180 / PI * 0.25, -25, 25);
    }
    var y = pos.y + (obj.bob ? obj.bob * Math.sin(t * obj.bobCycles * 2 * PI) : 0);
    return {
      x: pos.x,
      y: y,
      rotation: sampleArray(obj.rotation, t) + tilt,
      scale: sampleArray(obj.scale, t),
      opacity: clamp(sampleArray(obj.opacity, t), 0, 1),
      blur: Math.max(0, sampleArray(obj.blur || [0], t)),
      phase: raw * obj.flapsPerScroll
    };
  }

  function mount(host, config, options) {
    options = options || {};
    var scene = config.scene;
    var assets = config.assets || {};
    var stageHeight = options.stageHeight || '100vh';
    var reduced = !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches);

    host.innerHTML = '';
    var track = document.createElement('div');
    track.className = 'mf-track';
    track.style.cssText = 'position:relative;width:100%;';
    var stage = document.createElement('div');
    stage.className = 'mf-stage';
    stage.style.cssText = 'position:sticky;top:0;width:100%;height:' + stageHeight + ';overflow:hidden;pointer-events:none;';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Scroll-controlled animation');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;background:transparent;';
    stage.appendChild(canvas);
    track.appendChild(stage);
    host.appendChild(track);
    var ctx = canvas.getContext('2d');

    var imgs = {};
    var loaded = false;
    function loadImages() {
      if (loaded) return;
      loaded = true;
      Object.keys(assets).forEach(function (id) {
        imgs[id] = assets[id].map(function (url) {
          var im = new Image();
          im.decoding = 'async';
          im.onload = requestDraw;
          im.src = url;
          return im;
        });
      });
    }

    var target = reduced ? 0.5 : 0;
    var shown = target;
    var maxSeen = 0;
    var last = 0;
    var raf = 0;
    var visible = true;

    function layout() {
      track.style.height = reduced ? stage.offsetHeight + 'px' : (scene.scroll.length + stage.offsetHeight) + 'px';
    }

    function readProgress() {
      var max = track.offsetHeight - stage.offsetHeight;
      if (max <= 0) return 0;
      return clamp(-track.getBoundingClientRect().top / max, 0, 1);
    }

    function onScroll() {
      if (reduced) return;
      var p = readProgress();
      if (!scene.scroll.reverse) { p = Math.max(p, maxSeen); maxSeen = p; }
      target = p;
      requestDraw();
    }

    function requestDraw() { if (!raf) raf = g.requestAnimationFrame(tick); }

    function tick(now) {
      raf = 0;
      if (!visible) return;
      var dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
      last = now;
      var tau = scene.scroll.smoothing;
      if (reduced || tau <= 0) { shown = target; }
      else {
        shown += (target - shown) * (1 - Math.exp(-dt / tau));
        if (Math.abs(target - shown) < 0.0002) shown = target;
      }
      draw();
      if (shown !== target) requestDraw(); else last = 0;
    }

    function draw() {
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      var dpr = Math.min(g.devicePixelRatio || 1, 2);
      var cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var mobile = w < 768;
      var canBlur = 'filter' in ctx;
      for (var i = 0; i < scene.objects.length; i++) {
        var obj = scene.objects[i];
        var frames = imgs[obj.assetId];
        if (!frames || !frames.length) continue;
        var st = evaluate(obj, shown);
        var n = frames.length;
        var f = (((reduced ? 0 : st.phase) % 1) + 1) % 1 * n;
        var idx = Math.floor(f) % n, fr = f - Math.floor(f);
        var a = frames[idx], b = frames[(idx + 1) % n];
        if (!a.complete || !a.naturalWidth) continue;
        var dw = w * obj.widthPct / 100 * st.scale * (mobile ? obj.mobileScale : 1);
        var dh = dw * a.naturalHeight / a.naturalWidth;
        ctx.save();
        ctx.translate(st.x * w / 100, st.y * h / 100);
        ctx.rotate(st.rotation * PI / 180);
        ctx.globalAlpha = st.opacity;
        if (canBlur) ctx.filter = st.blur > 0 ? 'blur(' + st.blur + 'px)' : 'none';
        ctx.drawImage(a, -dw / 2, -dh / 2, dw, dh);
        if (n > 1 && fr > 0.001 && b.complete && b.naturalWidth) {
          ctx.globalAlpha = st.opacity * fr;
          ctx.drawImage(b, -dw / 2, -dh / 2, dw, dh);
        }
        ctx.restore();
      }
    }

    function onResize() { layout(); onScroll(); requestDraw(); }

    var io = null;
    if (g.IntersectionObserver) {
      io = new g.IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) { loadImages(); onScroll(); requestDraw(); }
      }, { rootMargin: '300px 0px' });
      io.observe(host);
    } else { loadImages(); }

    layout();
    g.addEventListener('scroll', onScroll, { passive: true });
    g.addEventListener('resize', onResize);
    if (!io) requestDraw();
    onScroll();
    requestDraw();

    return {
      update: function (newScene) { scene = newScene; layout(); onScroll(); requestDraw(); },
      getProgress: function () { return shown; },
      destroy: function () {
        g.removeEventListener('scroll', onScroll);
        g.removeEventListener('resize', onResize);
        if (io) io.disconnect();
        if (raf) g.cancelAnimationFrame(raf);
        host.innerHTML = '';
      }
    };
  }

  g.MotionForge = { mount: mount, evaluate: evaluate, samplePath: samplePath, sampleArray: sampleArray, easings: easings };
})(typeof window !== 'undefined' ? window : globalThis);
