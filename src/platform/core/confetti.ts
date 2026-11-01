/**
 * Lightweight Celebration Confetti
 * Triggers a multi-colored burst of confetti particles across the active container
 * when completing a study session or achieving milestones.
 */

export function triggerCelebrationConfetti(container: HTMLElement = document.body): void {
  if (typeof window === "undefined" || !container) return;

  const canvas = document.createElement("canvas");
  canvas.className = "learnkit-celebration-confetti";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "999";
  container.appendChild(canvas);

  const rect = container.getBoundingClientRect();
  canvas.width = rect.width || window.innerWidth;
  canvas.height = rect.height || window.innerHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  const colors = ["#58cc02", "#1cb0f6", "#ff9600", "#ff4b4b", "#ce82ff", "#ffc800"];
  const particles: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    color: string;
    rotation: number;
    vRotation: number;
    alpha: number;
  }> = [];

  const count = 45;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 80,
      y: canvas.height * 0.45 + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 12,
      vy: -Math.random() * 10 - 4,
      size: Math.random() * 8 + 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      vRotation: (Math.random() - 0.5) * 0.25,
      alpha: 1,
    });
  }

  let frameId: number;
  const start = performance.now();

  const animate = (time: number) => {
    const elapsed = time - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35; // Gravity
      p.vx *= 0.98; // Air resistance
      p.rotation += p.vRotation;

      if (elapsed > 1200) {
        p.alpha -= 0.02;
      }

      if (p.alpha > 0 && p.y < canvas.height + 20) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }

    if (alive && elapsed < 3000) {
      frameId = requestAnimationFrame(animate);
    } else {
      cancelAnimationFrame(frameId);
      canvas.remove();
    }
  };

  frameId = requestAnimationFrame(animate);
}
