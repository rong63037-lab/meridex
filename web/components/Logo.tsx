export function Logo({ className = "mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#07080A" />
      <circle cx="16" cy="16" r="11.25" stroke="url(#meridexMark)" strokeWidth="0.7" opacity="0.38" />
      <path d="M16 4.8c6.1 2.2 10.1 7.4 10.1 11.2S22.1 25 16 27.2C9.9 25 5.9 19.8 5.9 16S9.9 7 16 4.8Z" stroke="url(#meridexMark)" strokeWidth="0.85" />
      <path d="M9.15 22.7V10.6L16 17.35 22.85 10.6v12.1" stroke="url(#meridexMark)" strokeWidth="1.85" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M6.2 16h19.6" stroke="#F5D58A" strokeWidth="0.55" opacity="0.9" />
      <defs>
        <linearGradient id="meridexMark" x1="6" y1="5" x2="26" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F5D58A" />
          <stop offset="0.52" stopColor="#C9A24B" />
          <stop offset="1" stopColor="#8C6A2B" />
        </linearGradient>
      </defs>
    </svg>
  );
}
