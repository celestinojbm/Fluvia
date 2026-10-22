/**
 * ≤ 40 puntos menta en canvas 2D. Se alinean en filas al hacer scroll.
 * El llamador solo monta esto con viewport ≥ 768, deviceMemory ≥ 4 y sin
 * prefers-reduced-motion. Cero Three.js.
 */
type Dot = { x: number; y: number; row: number };

export function startParticles(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  const dots: Dot[] = Array.from({ length: 40 }, () => ({
    x: Math.random(),
    y: Math.random(),
    row: Math.floor(Math.random() * 6),
  }));
  let frame = 0;
  let running = false;

  const draw = () => {
    if (!running) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    context.clearRect(0, 0, canvas.width, canvas.height);
    const align = Math.min(1, window.scrollY / 640);
    context.fillStyle = '#B2FCE4';
    for (const dot of dots) {
      const x = dot.x * canvas.width;
      const freeY = dot.y * canvas.height;
      const rowY = ((dot.row + 1) / 8) * canvas.height;
      const y = freeY + (rowY - freeY) * align;
      context.globalAlpha = 0.45;
      context.beginPath();
      context.arc(x, y, 1.6 * ratio, 0, Math.PI * 2);
      context.fill();
    }
    frame = requestAnimationFrame(draw);
  };

  const start = () => {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(draw);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(frame);
  };

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) start();
    else stop();
  });
  observer.observe(canvas);
  return () => {
    stop();
    observer.disconnect();
  };
}
