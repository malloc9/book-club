import raw from './generated/books.json';
import type { BookData } from './types';

export const books = raw as unknown as BookData[];
export const asset = (p: string) => `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${p}`;
export const bookUrl = (slug: string) => asset(`konyv/${slug}/`);
