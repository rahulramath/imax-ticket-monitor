export interface MovieMeta {
  id: string;
  title: string;
  /** Short byline shown under the title */
  meta: string;
  /** North America release date (YYYY-MM-DD) — anchors far-future scanning */
  releaseDate: string;
  /** Poster image under /public */
  poster: string;
  /** Case-insensitive substring/regex used to match listings across sites */
  pattern: string;
}

export const MOVIES: MovieMeta[] = [
  {
    id: "odyssey",
    title: "The Odyssey",
    meta: "Christopher Nolan · Jul 17, 2026",
    releaseDate: "2026-07-17",
    poster: "/posters/odyssey.jpg",
    pattern: "odyssey",
  },
  {
    id: "dune-part-three",
    title: "Dune: Part Three",
    meta: "Denis Villeneuve · Dec 18, 2026",
    releaseDate: "2026-12-18",
    poster: "/posters/dune-part-three.jpg",
    pattern: "dune",
  },
  {
    id: "godzilla-minus-zero",
    title: "Godzilla Minus Zero",
    meta: "Takashi Yamazaki · Nov 6, 2026",
    releaseDate: "2026-11-06",
    poster: "/posters/godzilla-minus-zero.jpg",
    pattern: "godzilla",
  },
];

export function matchMovie(text: string): MovieMeta | null {
  for (const m of MOVIES) {
    if (new RegExp(m.pattern, "i").test(text)) return m;
  }
  return null;
}
