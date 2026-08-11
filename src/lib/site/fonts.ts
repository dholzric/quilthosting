export interface FontOption {
  label: string;
  category: 'sans' | 'serif' | 'display';
  googleQuery: string; // value after family= (before &)
  cssStack: string;
}
export const FONT_OPTIONS: Record<string, FontOption> = {
  inter: { label: 'Inter', category: 'sans',
    googleQuery: 'Inter:wght@400;500;600;700;800',
    cssStack: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  fraunces: { label: 'Fraunces', category: 'display',
    googleQuery: 'Fraunces:opsz,wght,SOFT@9..144,300..900,0..100',
    cssStack: "'Fraunces', Georgia, 'Times New Roman', serif" },
  playfair: { label: 'Playfair Display', category: 'serif',
    googleQuery: 'Playfair+Display:wght@400;600;700;800',
    cssStack: "'Playfair Display', Georgia, serif" },
  lora: { label: 'Lora', category: 'serif',
    googleQuery: 'Lora:wght@400;500;600;700',
    cssStack: "'Lora', Georgia, serif" },
  merriweather: { label: 'Merriweather', category: 'serif',
    googleQuery: 'Merriweather:wght@400;700;900',
    cssStack: "'Merriweather', Georgia, serif" },
  cormorant: { label: 'Cormorant', category: 'display',
    googleQuery: 'Cormorant:wght@400;500;600;700',
    cssStack: "'Cormorant', Georgia, serif" },
  poppins: { label: 'Poppins', category: 'sans',
    googleQuery: 'Poppins:wght@400;500;600;700;800',
    cssStack: "'Poppins', system-ui, sans-serif" },
  sourcesans: { label: 'Source Sans 3', category: 'sans',
    googleQuery: 'Source+Sans+3:wght@400;500;600;700',
    cssStack: "'Source Sans 3', system-ui, sans-serif" },
  worksans: { label: 'Work Sans', category: 'sans',
    googleQuery: 'Work+Sans:wght@400;500;600;700;800',
    cssStack: "'Work Sans', system-ui, sans-serif" },
  nunito: { label: 'Nunito', category: 'sans',
    googleQuery: 'Nunito:wght@400;500;600;700;800',
    cssStack: "'Nunito', system-ui, sans-serif" },
};
export function resolveFont(key: string): FontOption {
  return FONT_OPTIONS[key] ?? FONT_OPTIONS.inter;
}
export function buildFontsHref(headingKey: string, bodyKey: string): string {
  const heading = resolveFont(headingKey);
  const body = resolveFont(bodyKey);
  const families = heading.googleQuery === body.googleQuery
    ? [body.googleQuery]
    : [heading.googleQuery, body.googleQuery];
  const q = families.map((f) => `family=${f}`).join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}
