export interface Credit {
  artist: string | null;
  license: string | null;
  licenseUrl: string | null;
  source: string;
  sourceName: string;
}
export interface Image {
  src: string;
  width: number;
  height: number;
  credit: Credit | null;
}
export interface ArticleRef {
  lang: 'hu' | 'en';
  title: string;
  url: string;
}
export type Block =
  | string
  | { type: 'quote'; text: string; source: string | null }
  | { type: 'list'; items: string[] }
  | { type: 'heading'; text: string };
export interface BioSection {
  level: number;
  heading: string;
  paras: Block[];
}
export interface Work {
  wikidataId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  type: string | null;
  url: string | null;
  urlLang: 'hu' | 'en' | null;
}
export interface BookData {
  slug: string;
  title: string;
  authorName: string;
  fetchedAt: string | null;
  book: {
    wikidataId: string;
    article: ArticleRef | null;
    intro: Block[];
    plot: Block[] | null;
    facts: {
      originalTitle: string | null;
      published: string | null;
      language: string | null;
      genres: string[];
      country: string | null;
    };
    cover: Image | null;
  } | null;
  author: {
    wikidataId: string;
    name: string;
    article: ArticleRef | null;
    intro: Block[];
    biography: BioSection[];
    huEditions: string[] | null;
    works: Work[];
    facts: {
      birth: string | null;
      birthPlace: string | null;
      death: string | null;
      deathPlace: string | null;
      nationality: string[];
      occupations: string[];
    };
    portrait: Image | null;
  } | null;
}
