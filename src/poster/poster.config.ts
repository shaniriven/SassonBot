export const POSTER_CONFIG = {
  poster: { width: 1080, height: 1920 },
  overlay: { opacity: 0.62 },
  logo: {
    size: 250,
    sidePadding: 75,
  },
  center: {
    width: 240,
  },
  row: {
    height: 250,
    gap: 95,
  },
  font: {
    vsSize: 140,
    timeSize: 90,
    vsTimeGap: 20,
    color: '#FFFFFF',
    timeColor: '#D0D0D0',
    family: 'Russo One',
  },
} as const;

export const HEADLINER_POSTER_CONFIG = {
  headliner: {
    logoSize: 280,
    rowHeight: 280,
    centerWidth: 295,
    vsSize: 165,
    timeSize: 105,
    vsTimeGap: 24,
  },
  regular: {
    logoSize: 200,
    rowHeight: 200,
    centerWidth: 165,
    vsSize: 98,
    timeSize: 62,
    vsTimeGap: 14,
  },
  gap: 80,
  headlinerGap: 200,
} as const;
