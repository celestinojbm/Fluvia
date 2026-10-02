# Imágenes de la presentación

Este es un conjunto **cerrado** de fotos que el panel sirve en `/presentacion/<archivo>.jpg`. Se usa en:

- las tarjetas de categoría
- la portada
- la foto de perfil del directorio, si el comercio la elige

La fuente de verdad es `packages/commerce/src/presentation-images.ts`. La API rechaza cualquier otra referencia y la base de datos solo admite `presentacion/<nombre>.jpg`.

- **Licencia:** solo CC0 1.0. Se comprobó en la página de **origen** (Flickr, identificador de licencia `9`) el 2026-10-02. La búsqueda se hizo con Openverse, pero la verificación es la del origen.
- **Criterio:** sin personas reconocibles ni marcas visibles. CC0 cubre el derecho de autor, pero no la imagen de las personas que aparecen. Se descartó una foto cuyo título nombra un comercio real.
- **Tratamiento:**
  - recorte central 4:5
  - tamaño máximo 640×800, sin ampliar
  - JPEG progresivo con calidad 78
  - metadatos eliminados
  - `originalSha256` guarda la huella del archivo descargado
- **Sin recursos de terceros:** no se usan logos, fotos ni textos de Cashea ni de otras marcas. No hay URLs externas de imagen, porque la CSP es `img-src 'self'`.

| Archivo                         | Título original                                   | Autor              | Origen                                                  |
| ------------------------------- | ------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| `presentacion/alimentacion.jpg` | Crates of Corn                                    | Alabama Extension  | https://www.flickr.com/photos/184594136@N08/49909755653 |
| `presentacion/restaurantes.jpg` | Rekados Filipino Food 28Aug06 - 2                 | roland             | https://www.flickr.com/photos/35034347371@N01/228858019 |
| `presentacion/moda.jpg`         | Stylish rattan handbags on the balinese street …  | Artem Beliaikin    | https://www.flickr.com/photos/157635012@N07/28634261097 |
| `presentacion/hogar.jpg`        | Still Life of Kitchen Utensils, Herbs, and Spices | Image Catalog      | https://www.flickr.com/photos/132795455@N08/18392177145 |
| `presentacion/tecnologia.jpg`   | new Smartphone                                    | mkniebes           | https://www.flickr.com/photos/76696276@N00/26206972938  |
| `presentacion/salud.jpg`        | Medications                                       | freestocks.org     | https://www.flickr.com/photos/135396164@N05/28531160554 |
| `presentacion/papeleria.jpg`    | Stationery shop                                   | Abdulla Al Muhairi | https://www.flickr.com/photos/57866029@N00/53676417102  |
| `presentacion/servicios.jpg`    | THE SHOP                                          | PHOTOSHOP LOGIC    | https://www.flickr.com/photos/52904639@N08/17630933414  |
| `presentacion/portada.jpg`      | Cafetería                                         | Daquella manera    | https://www.flickr.com/photos/62518311@N00/85853908     |
| `presentacion/bodega-demo.jpg`  | Festival de la tomate                             | Isaszas            | https://www.flickr.com/photos/87805257@N00/29184010850  |
