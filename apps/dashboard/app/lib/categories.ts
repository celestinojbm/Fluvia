import type { CategorySlug } from './public-api';

/**
 * Categorías del directorio (lista cerrada, igual que la base de datos). La
 * foto es del conjunto CC0 verificado (`docs/product/presentacion-asistente/
 * imagenes.md`). Los textos describen el tipo de comercio, no prometen
 * comercios asociados ni disponibilidad.
 */
export const CATEGORIES: ReadonlyArray<{
  slug: CategorySlug;
  label: string;
  blurb: string;
  photo: string;
  alt: string;
}> = [
  {
    slug: 'alimentacion',
    label: 'Alimentación',
    blurb: 'Bodegas, mercados y abastos.',
    photo: '/presentacion/alimentacion.jpg',
    alt: 'Cajas de madera con mazorcas de maíz',
  },
  {
    slug: 'restaurantes',
    label: 'Restaurantes',
    blurb: 'Comida para llevar o en el local.',
    photo: '/presentacion/restaurantes.jpg',
    alt: 'Plato de fideos con huevo',
  },
  {
    slug: 'moda',
    label: 'Moda',
    blurb: 'Ropa, calzado y accesorios.',
    photo: '/presentacion/moda.jpg',
    alt: 'Bolsos de ratán colgados en una tienda',
  },
  {
    slug: 'hogar',
    label: 'Hogar',
    blurb: 'Cocina, ferretería y decoración.',
    photo: '/presentacion/hogar.jpg',
    alt: 'Utensilios de cocina, hierbas y especias sobre una mesa',
  },
  {
    slug: 'tecnologia',
    label: 'Tecnología',
    blurb: 'Teléfonos, accesorios y reparación.',
    photo: '/presentacion/tecnologia.jpg',
    alt: 'Teléfono móvil apoyado en una piedra',
  },
  {
    slug: 'salud',
    label: 'Salud y cuidado',
    blurb: 'Farmacias y cuidado personal.',
    photo: '/presentacion/salud.jpg',
    alt: 'Cápsulas y pastillas de colores',
  },
  {
    slug: 'papeleria',
    label: 'Papelería',
    blurb: 'Útiles, copias e impresión.',
    photo: '/presentacion/papeleria.jpg',
    alt: 'Estantes llenos de una papelería',
  },
  {
    slug: 'servicios',
    label: 'Servicios',
    blurb: 'Talleres y oficios.',
    photo: '/presentacion/servicios.jpg',
    alt: 'Taller con herramientas colgadas en la pared',
  },
];

export function categoryLabel(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}

export function isCategory(v: string | undefined): v is CategorySlug {
  return CATEGORIES.some((c) => c.slug === v);
}

export const CHANNEL_LABEL: Record<string, string> = {
  in_store: 'En tienda',
  online: 'En línea',
};
