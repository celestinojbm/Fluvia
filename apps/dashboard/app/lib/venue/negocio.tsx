'use client';

import { useState, type FormEvent } from 'react';
import { errorMessage } from '../client-call';
import { money } from '../ui';
import { QrCode } from './qr';
import {
  vcall,
  type BusinessProfile,
  type BusinessType,
  type Enablement,
  type VenueLayout,
} from './api';

/**
 * Configuración del negocio (owner/admin): tipo y módulos SOBRE LA MISMA
 * organización (cambiar no borra nada), habilitación de cobro presencial,
 * estructura del local, menú (estación, ingredientes, alérgenos,
 * modificadores) y personal con su rol de local por sucursal.
 * Cada acción refleja lo que el servidor devuelve; nada se marca hecho antes.
 */

const TYPES: Array<{ id: BusinessType; title: string; body: string }> = [
  { id: 'retail', title: 'Tienda', body: 'Catálogo, inventario y caja.' },
  { id: 'restaurant', title: 'Restaurante', body: 'Mesas, cocina, QR en mesa y cuenta dividida.' },
  { id: 'quick_service', title: 'Café / comida rápida', body: 'Pedidos al mostrador y cocina.' },
  {
    id: 'services',
    title: 'Independiente / servicios',
    body: 'Cobrar desde el teléfono sin tienda, productos ni mesas.',
  },
];
const MODULE_LABEL: Record<string, string> = {
  catalog: 'Catálogo',
  inventory: 'Inventario',
  pos: 'Caja (POS)',
  tables: 'Mesas',
  kitchen: 'Cocina (KDS)',
  qr_menu: 'Menú por QR',
  customer_orders: 'Pedidos del cliente',
  split_bill: 'Cuenta dividida',
  in_person: 'Cobro presencial',
  payment_links: 'Enlaces de pago',
};
const VENUE_ROLE_LABEL: Record<string, string> = {
  manager: 'Encargado',
  cashier: 'Cajero',
  waiter: 'Mesero',
  kitchen: 'Cocina',
};

export interface ProductLite {
  id: string;
  name: string;
  price: number;
  currency: string;
}
export interface MemberLite {
  user_id: string;
  email: string;
  role: string;
}
export interface StaffRow {
  user_id: string;
  email: string;
  role: string;
  branch_id: string | null;
}

export function NegocioWorkspace(props: {
  orgId: string;
  profile: BusinessProfile;
  enablement: Enablement;
  layout: VenueLayout;
  products: ProductLite[];
  members: MemberLite[];
  staff: StaffRow[];
}) {
  const { orgId } = props;
  const [profile, setProfile] = useState(props.profile);
  const [enablement, setEnablement] = useState(props.enablement);
  const [layout, setLayout] = useState(props.layout);
  const [staff, setStaff] = useState(props.staff);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [type, setType] = useState<BusinessType>(props.profile.business_type);
  const [modules, setModules] = useState<string[]>(props.profile.modules);
  const [solo, setSolo] = useState(props.profile.solo);
  const [needAcceptance, setNeedAcceptance] = useState(
    props.profile.customer_orders_need_acceptance
  );

  const report = (r: Parameters<typeof errorMessage>[0]) =>
    setMsg({ tone: 'bad', text: errorMessage(r) });
  const reloadLayout = async () => {
    const r = await vcall<VenueLayout>(orgId, 'venue');
    if (r.kind === 'ok') setLayout(r.body);
  };

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    const r = await vcall<BusinessProfile>(orgId, 'business-profile', {
      method: 'PUT',
      body: {
        business_type: type,
        modules,
        solo,
        customer_orders_need_acceptance: needAcceptance,
        expected_version: profile.version,
      },
    });
    if (r.kind !== 'ok') {
      return setMsg({
        tone: 'bad',
        text:
          r.kind === 'http' && r.code === 'version_conflict'
            ? 'Alguien cambió la configuración mientras editabas. Recarga para ver la versión actual.'
            : errorMessage(r),
      });
    }
    setProfile(r.body);
    setModules(r.body.modules);
    setMsg({ tone: 'ok', text: 'Configuración guardada. No se borró ningún dato.' });
  }

  const pickType = (t: BusinessType) => {
    setType(t);
    // Sugerencia: los módulos típicos del tipo (editable antes de guardar).
    const defaults: Record<BusinessType, string[]> = {
      retail: ['catalog', 'inventory', 'pos', 'payment_links', 'in_person'],
      restaurant: [
        'catalog',
        'pos',
        'tables',
        'kitchen',
        'qr_menu',
        'customer_orders',
        'split_bill',
        'payment_links',
        'in_person',
      ],
      quick_service: [
        'catalog',
        'pos',
        'kitchen',
        'qr_menu',
        'customer_orders',
        'payment_links',
        'in_person',
      ],
      services: ['payment_links', 'in_person'],
    };
    setModules(defaults[t]);
    setSolo(t === 'services');
  };

  async function completeReq(id: string) {
    const r = await vcall<Enablement>(orgId, `collection-enablement/requirements/${id}/complete`, {
      method: 'POST',
    });
    if (r.kind === 'ok') setEnablement(r.body);
    else report(r);
  }
  async function sandboxDecision(status: 'enabled' | 'restricted' | 'suspended') {
    const r = await vcall<Enablement>(orgId, 'collection-enablement/sandbox-decision', {
      method: 'POST',
      body: { status, reason: status === 'enabled' ? undefined : 'Decisión simulada (sandbox)' },
    });
    if (r.kind === 'ok') setEnablement(r.body);
    else
      setMsg({
        tone: 'bad',
        text:
          r.kind === 'http' && r.code === 'invalid_state_transition'
            ? 'El proveedor no puede habilitar todavía: faltan requisitos.'
            : r.kind === 'http' && r.status === 404
              ? 'La decisión simulada solo existe en sandbox.'
              : errorMessage(r),
      });
  }

  const venueOn = modules.includes('tables') || modules.includes('kitchen');

  return (
    <div className="vn-stack">
      {msg ? (
        <p className={msg.tone === 'ok' ? 'vn-pill' : 'vn-error'} data-tone="ok" role="status">
          {msg.text}
        </p>
      ) : null}

      <form className="vn-card" onSubmit={saveProfile} aria-labelledby="tipo-title">
        <h2 id="tipo-title">Tipo de negocio</h2>
        <p className="vn-help">
          Cambiar el tipo o los módulos solo cambia lo que ves y lo que el servidor acepta. Ningún
          dato (ventas, catálogo, pagos) se borra.
        </p>
        <div className="vn-types" role="radiogroup" aria-label="Tipo de negocio">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={type === t.id}
              className="vn-type"
              onClick={() => pickType(t.id)}
            >
              <strong>{t.title}</strong>
              <span>{t.body}</span>
            </button>
          ))}
        </div>
        <fieldset className="vn-fieldset">
          <legend>Módulos</legend>
          <div className="vn-chips">
            {Object.keys(MODULE_LABEL).map((m) => (
              <button
                key={m}
                type="button"
                className="vn-chip"
                aria-pressed={modules.includes(m)}
                onClick={() =>
                  setModules((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))
                }
              >
                {MODULE_LABEL[m]}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="vn-check">
          <input type="checkbox" checked={solo} onChange={(e) => setSolo(e.target.checked)} />
          Trabajo solo (sin personal ni sucursales)
        </label>
        <label className="vn-check">
          <input
            type="checkbox"
            checked={needAcceptance}
            onChange={(e) => setNeedAcceptance(e.target.checked)}
          />
          Los pedidos que hace el cliente por QR esperan mi aceptación antes de ir a cocina
        </label>
        <div className="vn-alt">
          <button type="submit" className="vn-cta vn-cta-sm">
            Guardar configuración
          </button>
        </div>
      </form>

      <section id="habilitacion" className="vn-card" aria-labelledby="hab-title">
        <h2 id="hab-title">Habilitación de cobro presencial</h2>
        <p>
          Estado:{' '}
          <span
            className="vn-pill"
            data-tone={
              enablement.status === 'enabled'
                ? 'ok'
                : enablement.status === 'pending'
                  ? 'warn'
                  : 'bad'
            }
          >
            {
              {
                pending: 'Pendiente',
                enabled: 'Habilitada',
                restricted: 'Restringida',
                suspended: 'Suspendida',
              }[enablement.status]
            }
          </span>{' '}
          {enablement.provider !== 'none' ? (
            <span className="vn-help">
              Proveedor:{' '}
              {enablement.provider === 'sandbox_simulator'
                ? 'simulador de sandbox (no cobra tarjetas reales)'
                : enablement.provider}
            </span>
          ) : null}
        </p>
        <p className="vn-help">
          Tener una cuenta no habilita cobrar con tarjeta: el proveedor revisa los requisitos y
          decide. Hoy ningún proveedor de Tap to Pay opera en Venezuela; ver «Estado de Tap to Pay».
        </p>
        <ul className="vn-reqs">
          {enablement.requirements.map((r) => (
            <li key={r.id}>
              <span aria-hidden="true">{r.done ? '✓' : '○'}</span> {r.label}{' '}
              <span className="fx-sr">{r.done ? '(cumplido)' : '(pendiente)'}</span>
              {!r.done ? (
                <button
                  type="button"
                  className="fx-btn fx-btn-sm"
                  onClick={() => void completeReq(r.id)}
                >
                  Marcar cumplido
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="vn-sim-panel">
          <p>
            <strong>Sandbox:</strong> simula la decisión del proveedor (en producción la toma el
            proveedor, no el comercio).
          </p>
          <div className="vn-alt">
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              onClick={() => void sandboxDecision('enabled')}
            >
              Proveedor habilita
            </button>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              onClick={() => void sandboxDecision('restricted')}
            >
              Proveedor restringe
            </button>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              onClick={() => void sandboxDecision('suspended')}
            >
              Proveedor suspende
            </button>
          </div>
        </div>
      </section>

      {venueOn ? (
        <VenueSetup
          orgId={orgId}
          layout={layout}
          onChange={reloadLayout}
          onError={report}
          products={props.products}
          members={props.members}
          staff={staff}
          setStaff={setStaff}
        />
      ) : null}
    </div>
  );
}

function VenueSetup({
  orgId,
  layout,
  onChange,
  onError,
  products,
  members,
  staff,
  setStaff,
}: {
  orgId: string;
  layout: VenueLayout;
  onChange: () => Promise<void>;
  onError: (r: Parameters<typeof errorMessage>[0]) => void;
  products: ProductLite[];
  members: MemberLite[];
  staff: StaffRow[];
  setStaff: (s: StaffRow[]) => void;
}) {
  const [branchName, setBranchName] = useState('');
  const post = async (path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') => {
    const r = await vcall(orgId, path, { method, body });
    if (r.kind !== 'ok') {
      onError(r);
      return false;
    }
    await onChange();
    return true;
  };

  return (
    <>
      <section className="vn-card" aria-labelledby="local-title">
        <h2 id="local-title">Local: sucursales, salones, mesas y estaciones</h2>
        <form
          className="vn-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (branchName.trim() && (await post('venue/branches', { name: branchName.trim() })))
              setBranchName('');
          }}
        >
          <label className="fx-field vn-grow">
            <span>Nueva sucursal</span>
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              maxLength={80}
            />
          </label>
          <button type="submit" className="fx-btn">
            Agregar sucursal
          </button>
        </form>
        {layout.branches.map((b) => (
          <BranchEditor key={b.id} branch={b} post={post} />
        ))}
      </section>

      <MenuSetup orgId={orgId} layout={layout} products={products} post={post} />

      <section className="vn-card" aria-labelledby="staff-title">
        <h2 id="staff-title">Personal del local</h2>
        <p className="vn-help">
          Encargado: todo. Cajero: pedidos, cuenta y cobro. Mesero: mesas, pedidos y pedir la
          cuenta. Cocina: comandas. El permiso se comprueba en el servidor en cada acción.
        </p>
        <StaffForm
          members={members}
          branches={layout.branches}
          onAssign={async (body) => {
            const r = await vcall(orgId, 'venue/staff', { method: 'POST', body });
            if (r.kind !== 'ok') return onError(r);
            const list = await vcall<{ data: StaffRow[] }>(orgId, 'venue/staff');
            if (list.kind === 'ok') setStaff(list.body.data);
          }}
        />
        <ul className="vn-lines">
          {staff.map((s) => (
            <li key={`${s.user_id}-${s.role}`} className="vn-line">
              <span>
                {s.email} — {VENUE_ROLE_LABEL[s.role] ?? s.role}
                <small>
                  {' '}
                  ·{' '}
                  {s.branch_id
                    ? layout.branches.find((b) => b.id === s.branch_id)?.name
                    : 'Todas las sucursales'}
                </small>
              </span>
              <button
                type="button"
                className="fx-btn fx-btn-sm fx-btn-ghost"
                onClick={async () => {
                  const r = await vcall(orgId, 'venue/staff/revoke', {
                    method: 'POST',
                    body: { user_id: s.user_id, role: s.role },
                  });
                  if (r.kind !== 'ok') return onError(r);
                  setStaff(staff.filter((x) => !(x.user_id === s.user_id && x.role === s.role)));
                }}
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function BranchEditor({
  branch: b,
  post,
}: {
  branch: VenueLayout['branches'][number];
  post: (path: string, body: unknown, method?: 'POST' | 'PUT') => Promise<boolean>;
}) {
  const [area, setArea] = useState('');
  const [table, setTable] = useState({ label: '', capacity: '4', area_id: b.areas[0]?.id ?? '' });
  const [station, setStation] = useState({ code: '', name: '' });
  const [showQr, setShowQr] = useState<string | null>(null);
  return (
    <article className="vn-branch" aria-label={`Sucursal ${b.name}`}>
      <h3>{b.name}</h3>
      <div className="vn-row">
        <form
          className="vn-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (area.trim() && (await post('venue/areas', { branch_id: b.id, name: area.trim() })))
              setArea('');
          }}
        >
          <label className="fx-field">
            <span>Nuevo salón</span>
            <input value={area} onChange={(e) => setArea(e.target.value)} maxLength={80} />
          </label>
          <button type="submit" className="fx-btn">
            Agregar salón
          </button>
        </form>
        <form
          className="vn-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!table.label.trim() || !table.area_id) return;
            if (
              await post('venue/tables', {
                branch_id: b.id,
                area_id: table.area_id,
                label: table.label.trim(),
                capacity: Number(table.capacity) || 1,
              })
            )
              setTable({ ...table, label: '' });
          }}
        >
          <label className="fx-field">
            <span>Mesa</span>
            <input
              value={table.label}
              onChange={(e) => setTable({ ...table, label: e.target.value })}
              maxLength={20}
              placeholder="M1"
            />
          </label>
          <label className="fx-field">
            <span>Capacidad</span>
            <input
              inputMode="numeric"
              value={table.capacity}
              onChange={(e) => setTable({ ...table, capacity: e.target.value })}
              size={3}
            />
          </label>
          <label className="fx-field">
            <span>Salón</span>
            <select
              value={table.area_id}
              onChange={(e) => setTable({ ...table, area_id: e.target.value })}
            >
              <option value="">—</option>
              {b.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="fx-btn" disabled={!b.areas.length}>
            Agregar mesa
          </button>
        </form>
        <form
          className="vn-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              station.code &&
              station.name &&
              (await post('venue/stations', { branch_id: b.id, ...station }))
            )
              setStation({ code: '', name: '' });
          }}
        >
          <label className="fx-field">
            <span>Estación (código)</span>
            <input
              value={station.code}
              onChange={(e) =>
                setStation({
                  ...station,
                  code: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
                })
              }
              placeholder="parrilla"
              maxLength={24}
            />
          </label>
          <label className="fx-field">
            <span>Nombre</span>
            <input
              value={station.name}
              onChange={(e) => setStation({ ...station, name: e.target.value })}
              maxLength={80}
            />
          </label>
          <button type="submit" className="fx-btn">
            Agregar estación
          </button>
        </form>
      </div>
      <p className="vn-help">
        Salones: {b.areas.map((a) => a.name).join(', ') || '—'} · Estaciones:{' '}
        {b.stations.map((s) => `${s.name} (${s.code})`).join(', ') || 'cocina por defecto'}
      </p>
      <ul className="vn-tables" aria-label="Mesas">
        {b.tables.map((t) => (
          <li key={t.id} className="vn-tile" data-state="free">
            <strong>{t.label}</strong>
            <span>{t.capacity} personas</span>
            {t.menu_url ? (
              <>
                <button
                  type="button"
                  className="fx-btn fx-btn-sm"
                  aria-expanded={showQr === t.id}
                  onClick={() => setShowQr(showQr === t.id ? null : t.id)}
                >
                  {showQr === t.id ? 'Ocultar QR' : 'Ver QR'}
                </button>
                {showQr === t.id ? (
                  <>
                    <QrCode
                      value={t.menu_url}
                      label={`QR del menú de la mesa ${t.label}`}
                      size={160}
                    />
                    <a className="vn-mono" href={t.menu_url} target="_blank" rel="noreferrer">
                      Abrir menú
                    </a>
                    <button
                      type="button"
                      className="fx-btn fx-btn-sm fx-btn-ghost"
                      onClick={() => void post(`venue/tables/${t.id}/rotate-qr`, {})}
                    >
                      Cambiar QR (invalida el anterior)
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}

function MenuSetup({
  orgId,
  layout,
  products,
  post,
}: {
  orgId: string;
  layout: VenueLayout;
  products: ProductLite[];
  post: (path: string, body: unknown, method?: 'POST' | 'PUT') => Promise<boolean>;
}) {
  const stations = [...new Set(layout.branches.flatMap((b) => b.stations.map((s) => s.code)))];
  const [group, setGroup] = useState({
    name: '',
    min: '0',
    max: '1',
    options: 'Queso:100, Tocineta:150',
  });
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <section className="vn-card" aria-labelledby="menu-title">
      <h2 id="menu-title">Menú: estación, ingredientes, alérgenos y modificadores</h2>
      <p className="vn-help">
        El cliente solo ve lo que cargues aquí. Si no informas alérgenos, el menú dice «no
        informado»: Fluvia nunca inventa ingredientes ni garantías.
      </p>
      <form
        className="vn-row"
        onSubmit={async (e) => {
          e.preventDefault();
          const options = group.options
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
            .map((x) => {
              const [name, delta] = x.split(':');
              return { name: name!.trim(), price_delta: Math.max(0, Number(delta ?? 0) || 0) };
            });
          const r = await vcall<{ id: string; name: string }>(orgId, 'venue/modifier-groups', {
            method: 'POST',
            body: {
              name: group.name,
              min_select: Number(group.min),
              max_select: Number(group.max),
              options,
            },
          });
          if (r.kind === 'ok') {
            setGroups([...groups, { id: r.body.id, name: r.body.name }]);
            setGroup({ ...group, name: '' });
          }
        }}
      >
        <label className="fx-field">
          <span>Grupo de modificadores</span>
          <input
            value={group.name}
            onChange={(e) => setGroup({ ...group, name: e.target.value })}
            placeholder="Extras"
          />
        </label>
        <label className="fx-field">
          <span>Mín.</span>
          <input
            inputMode="numeric"
            size={2}
            value={group.min}
            onChange={(e) => setGroup({ ...group, min: e.target.value })}
          />
        </label>
        <label className="fx-field">
          <span>Máx.</span>
          <input
            inputMode="numeric"
            size={2}
            value={group.max}
            onChange={(e) => setGroup({ ...group, max: e.target.value })}
          />
        </label>
        <label className="fx-field vn-grow">
          <span>Opciones (nombre:recargo en unidades menores)</span>
          <input
            value={group.options}
            onChange={(e) => setGroup({ ...group, options: e.target.value })}
          />
        </label>
        <button type="submit" className="fx-btn" disabled={!group.name.trim()}>
          Crear grupo
        </button>
      </form>
      <ul className="vn-lines">
        {products.map((p) => (
          <ProductRow
            key={p.id}
            product={p}
            stations={stations}
            groups={groups}
            onSave={async (calls) => {
              let ok = true;
              for (const [path, body] of calls) ok = (await post(path, body, 'PUT')) && ok;
              if (ok) setSaved(p.name);
            }}
          />
        ))}
      </ul>
      {saved ? (
        <p className="vn-pill" data-tone="ok" role="status">
          Guardado: {saved}
        </p>
      ) : null}
    </section>
  );
}

function ProductRow({
  product: p,
  stations,
  groups,
  onSave,
}: {
  product: ProductLite;
  stations: string[];
  groups: Array<{ id: string; name: string }>;
  onSave: (calls: Array<[string, unknown]>) => Promise<void>;
}) {
  const [station, setStation] = useState('');
  const [ingredients, setIngredients] = useState('');
  const [allergens, setAllergens] = useState('');
  const [group, setGroup] = useState('');
  return (
    <li className="vn-product-row">
      <strong>
        {p.name} <small>{money(p.price, p.currency)}</small>
      </strong>
      <div className="vn-row">
        <label className="fx-field">
          <span>Estación</span>
          <select value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">(sin cambio)</option>
            {stations.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="fx-field vn-grow">
          <span>Ingredientes</span>
          <input
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
            maxLength={500}
          />
        </label>
        <label className="fx-field vn-grow">
          <span>Alérgenos</span>
          <input value={allergens} onChange={(e) => setAllergens(e.target.value)} maxLength={300} />
        </label>
        <label className="fx-field">
          <span>Modificadores</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">(ninguno nuevo)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="fx-btn"
          onClick={() => {
            const calls: Array<[string, unknown]> = [];
            if (station) calls.push([`venue/products/${p.id}/route`, { station_code: station }]);
            if (ingredients || allergens)
              calls.push([
                `venue/products/${p.id}/info`,
                { ingredients: ingredients || null, allergen_info: allergens || null },
              ]);
            if (group)
              calls.push([`venue/products/${p.id}/modifier-groups/${group}`, { active: true }]);
            void onSave(calls);
          }}
        >
          Guardar
        </button>
      </div>
    </li>
  );
}

function StaffForm({
  members,
  branches,
  onAssign,
}: {
  members: MemberLite[];
  branches: VenueLayout['branches'];
  onAssign: (body: { user_id: string; role: string; branch_id: string | null }) => Promise<void>;
}) {
  const [user, setUser] = useState('');
  const [role, setRole] = useState('waiter');
  const [branch, setBranch] = useState('');
  return (
    <form
      className="vn-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (user) void onAssign({ user_id: user, role, branch_id: branch || null });
      }}
    >
      <label className="fx-field vn-grow">
        <span>Persona (miembro del equipo)</span>
        <select value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">—</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.email}
            </option>
          ))}
        </select>
      </label>
      <label className="fx-field">
        <span>Rol en el local</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {Object.entries(VENUE_ROLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="fx-field">
        <span>Sucursal</span>
        <select value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">Todas</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="fx-btn" disabled={!user}>
        Asignar
      </button>
    </form>
  );
}
