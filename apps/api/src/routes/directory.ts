import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from '@fluvia/db';
import { insertAuditEvent, type AuditAction } from '@fluvia/audit';
import {
  DIRECTORY_CATEGORIES,
  DIRECTORY_CHANNELS,
  PRESENTATION_IMAGE_REFS,
  type DirectoryProfileDto,
  type DirectoryService,
  type PublicDirectoryEntry,
} from '@fluvia/commerce';
import type { Security } from '../security.js';
import { FixedWindowLimiter, ipKey, rateLimit, type RateLimiter } from '../rate-limit.js';

/**
 * Directorio «Dónde comprar».
 *
 *  - Plano PÚBLICO (sin autenticación, limitado por IP): búsqueda y perfil de
 *    comercios PUBLICADOS. Solo columnas públicas; jamás ids internos.
 *  - Plano del COMERCIO (sesión): ver y editar su perfil (`merchants:write`
 *    para escribir), publicarlo con confirmación explícita y retirarlo. Toda
 *    escritura se audita en la misma transacción.
 */

const Category = z.enum(DIRECTORY_CATEGORIES);
const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'slug: 3–48 letras, números o guiones');
const Text = (max: number) => z.string().trim().min(1).max(max);

const SearchQuery = z
  .object({
    q: z.string().trim().max(80).optional(),
    category: Category.optional(),
    city: z.string().trim().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(48).default(24),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

const OrgParam = z.object({ orgId: z.string().uuid() });
const MerchantParams = z.object({ orgId: z.string().uuid(), merchantId: z.string().uuid() });
const SlugParam = z.object({ slug: Slug });

const ProfileBody = z
  .object({
    slug: Slug,
    display_name: Text(80),
    category: Category,
    city: Text(60),
    area: Text(60).nullable().optional(),
    summary: z.string().trim().max(280).nullable().optional(),
    channels: z
      .array(z.enum(DIRECTORY_CHANNELS))
      .min(1)
      .max(2)
      .refine((a) => new Set(a).size === a.length, 'duplicate channel'),
    photo_ref: z
      .enum(PRESENTATION_IMAGE_REFS as unknown as [string, ...string[]])
      .nullable()
      .optional(),
    /** 0 = crear; si no, la versión que el editor vio. */
    expected_version: z.number().int().min(0),
  })
  .strict();

const PublishBody = z
  .object({
    /** El comercio confirma que estos datos serán visibles para cualquiera. */
    confirm_public: z.literal(true),
    expected_version: z.number().int().min(1),
  })
  .strict();
const HideBody = z.object({ expected_version: z.number().int().min(1) }).strict();

function publicEntry(e: PublicDirectoryEntry) {
  return {
    object: 'directory_entry',
    slug: e.slug,
    display_name: e.displayName,
    category: e.category,
    city: e.city,
    area: e.area,
    summary: e.summary,
    channels: e.channels,
    photo_ref: e.photoRef,
    is_demo: e.isDemo,
    published_at: e.publishedAt,
  };
}

function ownProfile(p: DirectoryProfileDto) {
  return {
    object: 'directory_profile',
    id: p.id,
    merchant_id: p.merchantId,
    merchant_name: p.merchantName,
    slug: p.slug,
    display_name: p.displayName,
    category: p.category,
    city: p.city,
    area: p.area,
    summary: p.summary,
    channels: p.channels,
    photo_ref: p.photoRef,
    visibility: p.visibility,
    is_demo: p.isDemo,
    published_at: p.publishedAt,
    version: p.version,
    updated_at: p.updatedAt,
  };
}

export interface DirectoryRoutesOptions {
  security: Security;
  directoryService: DirectoryService;
  limiter?: RateLimiter;
}

export function registerDirectoryRoutes(
  app: FastifyInstance,
  { security, directoryService, limiter }: DirectoryRoutesOptions
): void {
  const publicLimit = {
    preHandler: rateLimit(limiter ?? new FixedWindowLimiter(), [
      { keyOf: ipKey('directory:ip'), rule: { max: 600, windowMs: 60_000 } },
    ]),
  };
  const read = { preHandler: [security.session, security.org('payments:read')] };
  const write = { preHandler: [security.session, security.org('merchants:write')] };
  const tenant = (req: FastifyRequest) => req.org!.organizationId;
  const auditor =
    (req: FastifyRequest, action: AuditAction) => (c: PoolClient, p: DirectoryProfileDto) =>
      insertAuditEvent(c, {
        action,
        tenantId: tenant(req),
        context: {
          actorType: 'user',
          actorId: req.identity!.userId,
          authMethod: 'session',
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        resourceType: 'directory_profile',
        resourceId: p.id,
        riskLevel: action === 'directory_profile.published' ? 'medium' : 'low',
        reason: 'directory: merchant edits its public profile (session plane)',
        after: {
          slug: p.slug,
          visibility: p.visibility,
          version: p.version,
          category: p.category,
          city: p.city,
        },
      });

  // ── Público ───────────────────────────────────────────────────────────────
  app.get('/v1/public/directory', publicLimit, async (req) => {
    const q = SearchQuery.parse(req.query ?? {});
    const data = await directoryService.search({
      q: q.q || undefined,
      category: q.category,
      city: q.city || undefined,
      limit: q.limit,
      offset: q.offset,
    });
    return { object: 'list', data: data.map(publicEntry), has_more: data.length === q.limit };
  });

  app.get('/v1/public/directory/cities', publicLimit, async () => ({
    object: 'list',
    data: await directoryService.cities(),
  }));

  app.get('/v1/public/directory/:slug', publicLimit, async (req) => {
    const { slug } = SlugParam.parse(req.params);
    return publicEntry(await directoryService.profile(slug));
  });

  // ── Comercio ──────────────────────────────────────────────────────────────
  app.get('/v1/organizations/:orgId/directory/profiles', read, async (req) => {
    OrgParam.parse(req.params);
    const list = await directoryService.listOwn(tenant(req));
    return { object: 'list', data: list.map(ownProfile) };
  });

  app.put('/v1/organizations/:orgId/directory/profiles/:merchantId', write, async (req) => {
    const { merchantId } = MerchantParams.parse(req.params);
    const b = ProfileBody.parse(req.body);
    const saved = await directoryService.upsert(
      tenant(req),
      merchantId,
      {
        slug: b.slug,
        displayName: b.display_name,
        category: b.category,
        city: b.city,
        area: b.area ?? null,
        summary: b.summary || null,
        channels: b.channels,
        photoRef: b.photo_ref ?? null,
      },
      b.expected_version,
      auditor(req, 'directory_profile.saved')
    );
    return ownProfile(saved);
  });

  app.post(
    '/v1/organizations/:orgId/directory/profiles/:merchantId/publish',
    write,
    async (req) => {
      const { merchantId } = MerchantParams.parse(req.params);
      const b = PublishBody.parse(req.body);
      return ownProfile(
        await directoryService.publish(
          tenant(req),
          merchantId,
          b.expected_version,
          auditor(req, 'directory_profile.published')
        )
      );
    }
  );

  app.post('/v1/organizations/:orgId/directory/profiles/:merchantId/hide', write, async (req) => {
    const { merchantId } = MerchantParams.parse(req.params);
    const b = HideBody.parse(req.body);
    return ownProfile(
      await directoryService.hide(
        tenant(req),
        merchantId,
        b.expected_version,
        auditor(req, 'directory_profile.hidden')
      )
    );
  });
}
