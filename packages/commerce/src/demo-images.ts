/**
 * Imágenes de productos de DEMOSTRACIÓN: conjunto cerrado de archivos propios
 * servidos por el dashboard y el checkout en `/catalog/<archivo>.jpg`.
 *
 * - Solo CC0 1.0 (la política de licencias del repo admite CC0; CC-BY requiere
 *   decisión humana). Licencia comprobada en la página de ORIGEN el 2026-10-01
 *   (Flickr: id de licencia 9 = CC0 1.0; StockSnap: «CC0 License»). Las de
 *   rawpixel (403 al verificar), una con 404 y una «Public Domain Mark» se
 *   descartaron.
 * - Recortadas a 480×480 y recomprimidas (JPEG q72); `originalSha256` es la
 *   huella del archivo descargado del origen.
 * - Por qué un conjunto cerrado: la CSP de ambas apps es `img-src 'self'` y
 *   subir imágenes requiere almacenamiento, que no está autorizado.
 */
export interface DemoImage {
  ref: string;
  label: string;
  title: string;
  creator: string;
  source: string;
  sourceUrl: string;
  license: 'CC0-1.0';
  licenseUrl: string;
  verification: string;
  originalSha256: string;
}

export const DEMO_PRODUCT_IMAGES: readonly DemoImage[] = [
  {
    ref: 'catalog/agua.jpg',
    label: 'Agua embotellada',
    title: 'Plastic PET Water Bottles: Empty, Full, Cold',
    creator: 'qubodup',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/21051491@N02/7803156280',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: 'ad4ba0f3f487ac0cf435b8dabc8a04e6d613e89fd304c4f1a2321cb28bc2a4e5',
  },
  {
    ref: 'catalog/boligrafos.jpg',
    label: 'Bolígrafos sobre papel',
    title: 'Office Work',
    creator: 'Jeffrey Betts',
    source: 'stocksnap',
    sourceUrl: 'https://stocksnap.io/photo/office-work-91WZ32J28K',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'stocksnap page (2026-10-01): CC0 License, enlace publicdomain/zero/1.0',
    originalSha256: 'e71981a351e46f8b83d8d7a0a19c703ef2391a975d4bd43c5548ad9f23a9632a',
  },
  {
    ref: 'catalog/cafe-grano.jpg',
    label: 'Café en grano',
    title: 'Coffee Beans',
    creator: 'megforce1',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/35608308@N05/22247100615',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: 'aea3e4c017be49a33fca91e47bbb1e3f4ad184da8f618554e7687357711b5ec4',
  },
  {
    ref: 'catalog/cuaderno.jpg',
    label: 'Cuaderno abierto',
    title: 'Notebook Paper',
    creator: 'Dana Marin',
    source: 'stocksnap',
    sourceUrl: 'https://stocksnap.io/photo/notebook-paper-DXP038JQNB',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'stocksnap page (2026-10-01): CC0 License, enlace publicdomain/zero/1.0',
    originalSha256: '6e97f682c6fec395f3ec26bf162ddd41a3819c111f8d641fa609b82d7f9ebf15',
  },
  {
    ref: 'catalog/huevos.jpg',
    label: 'Huevos en cartón',
    title: 'Fresh Eggs',
    creator: 'cogdogblog',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/37996646802@N01/2543297739',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: 'b86ead7c92be65b81c101f6dc1b8b3a0786316f4eff09cec4ad4d1b3af668057',
  },
  {
    ref: 'catalog/jugo-naranja.jpg',
    label: 'Jugo de naranja',
    title: 'drink-breakfast-orange-juice',
    creator: 'pixellaphoto',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/137643065@N06/23958994069',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: 'b124594cec842a1c3bedb73486ddaed8295e045b30b0d138dafb862fd6666986',
  },
  {
    ref: 'catalog/pan.jpg',
    label: 'Pan artesanal',
    title: 'Bread made in the country',
    creator: 'Isaszas',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/87805257@N00/29640323016',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: '3cf62ae6ac22ebbb13bfb17d035f0b4779c283ea588b62f5a17e02763ee05d28',
  },
  {
    ref: 'catalog/platanos.jpg',
    label: 'Plátanos',
    title: 'Plantain bananas: Mechanical bruising injury to peels',
    creator: 'Plant pests and diseases',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/62295966@N07/37515979381',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: 'f396b4674fa827e00a48b7aa4c6620e269e1c9b7ad01d1a45297bb652c7ee3a2',
  },
  {
    ref: 'catalog/queso.jpg',
    label: 'Tabla de quesos',
    title: 'Cheese, Wine and Bread.',
    creator: 'Mustang Joe',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/63234672@N04/19757310168',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: '9c9835dfcda1131c3ddd621b90c9d6ce1a9e3bd0dc57d4aabb3ce13a8465016d',
  },
  {
    ref: 'catalog/refresco.jpg',
    label: 'Refresco',
    title: 'Raspberry lemonade on a wooden table. Iced summer drink.',
    creator: 'Artem Beliaikin',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/157635012@N07/43108065435',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0',
    originalSha256: 'fc5fa23ed2568a03b2ea140763c0b02d4c0a2da19f10c72ddbbb911f86f1eeb2',
  },
];

export const DEMO_IMAGE_REFS = DEMO_PRODUCT_IMAGES.map((i) => i.ref);

export function isDemoImageRef(ref: string): boolean {
  return DEMO_IMAGE_REFS.includes(ref);
}
