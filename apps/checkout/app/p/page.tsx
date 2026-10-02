import { TrackingClient } from './tracking-client';
import '../mesa.css';

export const dynamic = 'force-dynamic';

/** Seguimiento del pedido del comensal. El token viaja en el fragmento (#): nunca llega al servidor web ni a sus registros. */
export default function TrackingPage() {
  return <TrackingClient />;
}
