"use client"

export function AnimatedBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Base dark */}
      <div className="absolute inset-0 bg-background" />

      {/* Radial glow – top-left accent */}
      <div
        className="absolute -left-1/4 -top-1/4 h-[80vh] w-[80vh] rounded-full opacity-[0.07]"
        style={{
          background:
            "radial-gradient(circle, oklch(0.72 0.19 160) 0%, transparent 70%)",
        }}
      />

      {/* Radial glow – bottom-right accent */}
      <div
        className="absolute -bottom-1/4 -right-1/4 h-[60vh] w-[60vh] rounded-full opacity-[0.05]"
        style={{
          background:
            "radial-gradient(circle, oklch(0.72 0.19 160) 0%, transparent 70%)",
        }}
      />

      {/* Grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(oklch(0.95 0 0) 1px, transparent 1px), linear-gradient(90deg, oklch(0.95 0 0) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />
    </div>
  )
}
