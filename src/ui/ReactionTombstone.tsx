export function ReactionTombstone() {
  return (
    <div className="reaction-tombstone" aria-hidden="true">
      <svg
        className="tombstone-stone"
        viewBox="0 0 36 44"
        shapeRendering="crispEdges"
        focusable="false"
      >
        <path fill="#343532" d="M12 1h11v2h3v3h2v29h3v2h4v6H1v-6h4v-2h3V6h2V3h2z" />
        <path fill="#8d8b7f" d="M12 3h11v2h3v30h-3V7h-3V5h-8z" />
        <path fill="#d0cab7" d="M12 4h9v2h3v29H10V7h2z" />
        <path fill="#e8e1ca" d="M12 4h9v2h-8v2h-2v26H9V7h3z" />
        <path fill="#77796f" d="M22 8h2v25h-2zM11 33h13v2H11z" />
        <path fill="#a39f8e" d="M13 8h7v2h2v21H12V10h1z" />
        <path fill="#c8c2ad" d="M14 9h5v2h2v19h-8V11h1z" />
        <path
          fill="#716f62"
          d="M15 10h3v2h-3zM14 14h5v1h-2v3h-2v-2h-1zM18 18h2v3h-4v-1h2zM14 22h5v2h-2v2h-2v-2h-1zM15 28h5v1h-5z"
        />
        <path fill="#e0d8be" d="M16 12h3v1h-3zM13 18h2v1h-2zM17 25h3v1h-3zM12 31h7v1h-7z" />
        <path fill="#817f70" d="M10 26h2v2h-1v4H9v-2h1zM21 6h2v1h-2zM22 30h2v2h-2z" />
        <path fill="#b5b29f" d="M8 35h18v2h5v2H5v-2h3z" />
        <path fill="#e0dcc8" d="M9 35h14v1H9zM5 38h25v1H5z" />
        <path fill="#6d7068" d="M3 39h30v3H3z" />
        <path fill="#b7baab" d="M3 39h18v2H3z" />
        <path fill="#e0e1d2" d="M3 39h8v1H3zM12 39h8v1h-8z" />
        <path fill="#92978c" d="M22 39h10v1H22zM5 36h3v2H5zM27 36h3v2h-3z" />
        <path fill="#4c514b" d="M11 39h1v3h-1zM21 38h1v4h-1zM29 40h1v2h-1z" />
      </svg>
      <span className="tombstone-dust dust-left" />
      <span className="tombstone-dust dust-right" />
    </div>
  );
}
