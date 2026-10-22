import type { Ref, SVGProps } from 'react';
import { Dots, Line, Solid } from '../../iso/react/draw';
import { ART, HEIGHT, REST_FRAME, WIDTH, type Frame } from './geometry';

export interface ArtRefs {
  carriage?: Ref<SVGGElement>;
  needle?: Ref<SVGPathElement>;
  coils?: Array<Ref<SVGPathElement>>;
}

/**
 * Dibujo en reposo. El cliente solo mueve el carro, los muelles y la aguja
 * escribiendo atributos: la primera pintura coincide con el póster.
 */
export function MostradorArt({
  frame = REST_FRAME,
  refs,
  svgProps,
}: {
  frame?: Frame;
  refs?: ArtRefs;
  svgProps?: SVGProps<SVGSVGElement>;
}) {
  const coilRefs = refs?.coils ?? [];
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="Banco de mostrador. Una ficha recorre dos rieles desde la bandeja de quien paga hasta el cajón del comercio. Un cajón cerrado, el del crédito, queda fuera de los rieles."
      focusable="false"
      {...svgProps}
      className={svgProps?.className ? `iso-svg ${svgProps.className}` : 'iso-svg'}
    >
      <path className="iso-halo" d={ART.halo} />
      {ART.feet.map((foot) => (
        <g key={foot.key}>
          <Solid paths={foot.flange} tone="lo" />
          <Solid paths={foot.stem} tone="mid" />
        </g>
      ))}
      <Solid paths={ART.base} tone="mid" />
      <Line d={ART.groove} tone="lo" />
      <Line d={ART.plateScrews.ring} tone="lo" />
      <Dots points={ART.plateScrews.dots} size={0.48} tone="mid" />
      <Solid paths={ART.strip} tone="lo" crease="none" />
      <Line d={ART.rulerMinor} tone="lo" />
      <Line d={ART.rulerMajor} tone="mid" />
      <Solid paths={ART.label} tone="lo" />
      <Line d={ART.labelEdge} tone="faint" />
      <Line d={ART.labelRules} tone="lo" free />
      <Dots points={ART.labelScrews.dots} size={0.38} tone="mid" />
      <Line d={ART.labelScrews.ring} tone="lo" />

      <Solid paths={ART.collar} tone="lo" />
      <Solid paths={ART.post} tone="mid" crease="none" />
      <Line d={ART.postSeamA} tone="faint" />
      <Line d={ART.postSeamB} tone="faint" />
      <Solid paths={ART.bezel} tone="mid" />
      <Solid paths={ART.face} tone="hi" />
      <Line d={ART.dialTicksMinor} tone="lo" />
      <Line d={ART.dialTicksMajor} tone="mid" />
      <Line d={ART.zeroTick} tone="hi" />
      <Line d={ART.glass} tone="hi" />
      <Solid paths={ART.hub} tone="mid" />
      <path
        ref={refs?.needle}
        className="iso-line"
        data-tone="hi"
        d={frame.needle}
        data-free="end"
      />
      <Solid paths={ART.crown} tone="mid" />
      <Line d={ART.crownKnurl} tone="lo" />

      <Solid paths={ART.farWall} tone="mid" />
      <Solid paths={ART.trayFloor} tone="lo" />
      {ART.coins.map((paths, index) => (
        <Solid key={`coin-${index}`} paths={paths} tone="lo" />
      ))}
      <Solid paths={ART.leftWall} tone="mid" />
      <Solid paths={ART.rightWall} tone="mid" />
      <Solid paths={ART.nearWall} tone="mid" />
      <Line d={ART.trayLip} tone="lo" />

      <Solid paths={ART.railBack} tone="mid" />
      <Solid paths={ART.railFront} tone="mid" />
      <Solid paths={ART.stopL} tone="mid" />
      <Solid paths={ART.stopR} tone="mid" />
      <Line d={ART.stopScrews.ring} tone="lo" />
      <Dots points={ART.stopScrews.dots} size={0.4} tone="mid" />

      <path ref={coilRefs[0]} className="iso-line" data-tone="mid" d={frame.coils[0]} />
      <path ref={coilRefs[1]} className="iso-line" data-tone="mid" d={frame.coils[1]} />

      <g ref={refs?.carriage} transform={frame.carriage}>
        <Solid paths={ART.carriage} tone="mid" />
        {ART.bushes.map((paths, index) => (
          <Solid key={`bush-${index}`} paths={paths} tone="lo" />
        ))}
        <Line d={ART.bushScrews.ring} tone="lo" />
        <Dots points={ART.bushScrews.dots} size={0.36} tone="mid" />
        <Dots points={ART.rivets} size={0.42} tone="hi" />
        <Solid paths={ART.token} tone="hi" lit />
        <Line d={ART.tokenRim} tone="lit" />
        <Solid paths={ART.neck} tone="mid" />
        <Solid paths={ART.knob} tone="mid" />
        <Line d={ART.knurl} tone="lo" />
        <Line d={ART.pointer} tone="hi" />
      </g>

      <path ref={coilRefs[2]} className="iso-line" data-tone="mid" d={frame.coils[2]} />
      <path ref={coilRefs[3]} className="iso-line" data-tone="hi" d={frame.coils[3]} />

      <Solid paths={ART.till} tone="mid" inner={<Line d={ART.tillSeam} tone="faint" />} />
      {ART.hinges.map((paths, index) => (
        <Solid key={`hinge-${index}`} paths={paths} tone="lo" />
      ))}
      <Solid paths={ART.lid} tone="hi" />
      <Line d={ART.slot} tone="lo" />

      <Solid paths={ART.drawer} tone="lo" />
      <Solid paths={ART.pull} tone="mid" />
      <Line d={ART.pullKnurl} tone="lo" />
      <Line d={ART.drawerScrews.ring} tone="lo" />
      <Dots points={ART.drawerScrews.dots} size={0.38} tone="mid" />
    </svg>
  );
}
