export interface FontDef {
  family: string;
  woffPath: string;
}

export const FONTS: FontDef[] = [
  {
    family: 'Anton',
    woffPath:
      require.resolve('@fontsource/anton/files/anton-latin-400-normal.woff'),
  },
  {
    family: 'Bebas Neue',
    woffPath:
      require.resolve('@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff'),
  },
  {
    family: 'Black Han Sans',
    woffPath:
      require.resolve('@fontsource/black-han-sans/files/black-han-sans-latin-400-normal.woff'),
  },
  {
    family: 'Passion One',
    woffPath:
      require.resolve('@fontsource/passion-one/files/passion-one-latin-900-normal.woff'),
  },
  {
    family: 'Russo One',
    woffPath:
      require.resolve('@fontsource/russo-one/files/russo-one-latin-400-normal.woff'),
  },
  {
    family: 'Teko',
    woffPath:
      require.resolve('@fontsource/teko/files/teko-latin-700-normal.woff'),
  },
];

export const DEFAULT_FONT_FAMILY = 'Russo One';
export const ACTIVE_FONT_FAMILIES = FONTS.map((font) => font.family);
