import type { DemoImage } from './demo-images.js';

/**
 * Fotos de la PRESENTACIÓN (categorías, portada y perfiles del directorio):
 * conjunto cerrado servido por el dashboard en `/presentacion/<archivo>.jpg`.
 *
 * - Solo CC0 1.0, comprobada en la página de ORIGEN (Flickr, id de licencia 9)
 *   el 2026-10-02. Búsqueda vía Openverse; la verificación es la del origen.
 * - Criterio: sin personas reconocibles ni marcas visibles (CC0 cubre el
 *   derecho de autor, no la imagen de las personas). Se descartó una foto cuyo
 *   título nombra un comercio real.
 * - Recorte central 4:5, ≤ 640×800, JPEG q78 progresivo, metadatos eliminados.
 *   `originalSha256` es la huella del archivo descargado.
 * - No se usa ningún recurso de terceros como Cashea (logos, fotos o textos).
 */
export const PRESENTATION_IMAGES: readonly DemoImage[] = [
  {
    ref: 'presentacion/alimentacion.jpg',
    label: 'Cajas de mazorcas de maíz',
    title: 'Crates of Corn',
    creator: 'Alabama Extension',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/184594136@N08/49909755653',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: 'b7c3f060bf4a48eb5670624158e19b358996f347dec6c80931e78f3638317cc8',
  },
  {
    ref: 'presentacion/restaurantes.jpg',
    label: 'Plato de fideos con huevo',
    title: 'Rekados Filipino Food 28Aug06 - 2',
    creator: 'roland',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/35034347371@N01/228858019',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: '94e8aa56a9edfa7fc510438d7a1e87bc835598d19279f817156bd459d31a49d5',
  },
  {
    ref: 'presentacion/moda.jpg',
    label: 'Bolsos de ratán colgados',
    title: 'Stylish rattan handbags on the balinese street in Ubud.',
    creator: 'Artem Beliaikin',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/157635012@N07/28634261097',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: 'ca0a4bfe9143b00ee0f2377799b74d2c99685cb3393ddff7aa3d1d8a98036268',
  },
  {
    ref: 'presentacion/hogar.jpg',
    label: 'Utensilios de cocina y especias',
    title: 'Still Life of Kitchen Utensils, Herbs, and Spices',
    creator: 'Image Catalog',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/132795455@N08/18392177145',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: '4a588f2187aa6f1025c8a655b604d69415aae42847cef047efe027b74d558b7a',
  },
  {
    ref: 'presentacion/tecnologia.jpg',
    label: 'Teléfono sobre piedra',
    title: 'new Smartphone',
    creator: 'mkniebes',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/76696276@N00/26206972938',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: '7c4b8caed08826130bd79cae64a2b3e1cbed5d3a2f1daf4c86343f5c08b6866b',
  },
  {
    ref: 'presentacion/salud.jpg',
    label: 'Cápsulas y pastillas de colores',
    title: 'Medications',
    creator: 'freestocks.org',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/135396164@N05/28531160554',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: '94c34dd256aafe04f31bffa7e03114bd32f85e94d1fa42c8b735feb38a2b754b',
  },
  {
    ref: 'presentacion/papeleria.jpg',
    label: 'Estantes de una papelería',
    title: 'Stationery shop',
    creator: 'Abdulla Al Muhairi',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/57866029@N00/53676417102',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: 'd731683cd4f2e3621e6b96f07ee5841056f396161c797482d17301196289b0e0',
  },
  {
    ref: 'presentacion/servicios.jpg',
    label: 'Taller con herramientas',
    title: 'THE SHOP',
    creator: 'PHOTOSHOP LOGIC',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/52904639@N08/17630933414',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: 'da8e286cc413d0a5060b5bf0aeb6ab13e310fd62493381825bf974b1850988fd',
  },
  {
    ref: 'presentacion/portada.jpg',
    label: 'Mostrador de una cafetería',
    title: 'Cafetería',
    creator: 'Daquella manera',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/62518311@N00/85853908',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: '6d358d5ae493c90e305d92944b0761b5b5a1846f7667bf13339b00dc22ec1e08',
  },
  {
    ref: 'presentacion/bodega-demo.jpg',
    label: 'Tomates frescos',
    title: 'Festival de la tomate',
    creator: 'Isaszas',
    source: 'flickr',
    sourceUrl: 'https://www.flickr.com/photos/87805257@N00/29184010850',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verification: 'flickr license id 9 = CC0 1.0 (página de origen, 2026-10-02)',
    originalSha256: '9d2eab81b3f83aa4a5fe99318c0cca78705b7042b4cf8ebe9349a1d0eb736222',
  },
];

export const PRESENTATION_IMAGE_REFS: readonly string[] = PRESENTATION_IMAGES.map((i) => i.ref);

export function isPresentationImageRef(ref: string): boolean {
  return PRESENTATION_IMAGE_REFS.includes(ref);
}
