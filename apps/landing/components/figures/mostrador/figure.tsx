import { Plate } from '../../iso/react/draw';
import '../../iso/iso.css';
import { MostradorArt } from './art';
import { MostradorStage } from './stage';

const KEYS = [
  { mark: 'lit' as const, label: 'La ficha del pago' },
  { mark: 'raised' as const, label: 'El carro sobre los rieles' },
  { mark: 'edge' as const, label: 'El muelle que la devuelve a la bandeja' },
];

const CAPTION =
  'La ficha sale de la bandeja de quien paga. El carro la lleva por dos rieles hasta el cajón del comercio, y el muelle la devuelve si la sueltas antes de llegar. El cajón de delante está cerrado: es el crédito, y no alimenta la bandeja. El crédito no es saldo propio.';

function Poster() {
  return (
    <div className="iso" data-theme="light">
      <Plate
        fig="Fig 1"
        title="Del mostrador al cajón"
        hint="Figura en reposo"
        readout="en la bandeja"
        keys={KEYS}
        caption={CAPTION}
      >
        <MostradorArt />
      </Plate>
    </div>
  );
}

export function MostradorFigure() {
  return <MostradorStage poster={<Poster />} />;
}
