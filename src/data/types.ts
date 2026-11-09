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
  lang: string;
  title: string;
  url: string;
  translated?: boolean;
}
export type Inline = string | { text: string; href: string };
export type Block =
  | string
  | { type: 'rich'; parts: Inline[] }
  | { type: 'quote'; text: string; source: string | null }
  | { type: 'list'; items: (string | Inline[])[] }
  | { type: 'heading'; text: string };
export interface BioSection {
  level: number;
  heading: string;
  paras: Block[];
}
export interface Work {
  wikidataId: string | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  type: string | null;
  url: string | null;
  urlLang: string | null;
  clubTitle?: string;
}
export interface BookData {
  slug: string;
  title: string;
  authorName: string;
  fetchedAt: string | null;
  book: {
    wikidataId: string | null;
    article: ArticleRef | null;
    intro: Block[];
    introFromAuthor?: boolean;
    introManual?: boolean;
    sources?: { name: string; url: string }[];
    plot: Block[] | null;
    facts: {
      originalTitle: string | null;
      published: string | null;
      language: string | null;
      genres: string[];
      country: string | null;
      publisher?: string | null;
      pages?: number | null;
      awards?: string[];
    };
    cover: Image | null;
  } | null;
  author: {
    wikidataId: string;
    name: string;
    article: ArticleRef | null;
    intro: Block[];
    biography: BioSection[];
    biographyArticle?: ArticleRef | null;
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
