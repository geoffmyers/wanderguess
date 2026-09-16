'use client';

import { ATTRIBUTION } from '@/lib/game/constants';
import type { GameLocation } from '@/lib/types/location';

interface Props {
  location: GameLocation;
}

/**
 * Licence compliance, not decoration.
 *
 * Mapillary imagery is CC BY-SA 4.0, which requires crediting the contributor
 * with a link, and Mapillary's API terms separately require a visible link back
 * to their homepage wherever their data is used.
 *
 * OpenStreetMap is here because ODbL requires it wherever OSM-derived data
 * appears, and the round on screen is full of it: the street being asked about,
 * the four alternatives beside it, and the city and region that were verified
 * through Nominatim. That was true from the moment the street tier shipped and
 * this bar did not say so - the pipeline had the sources long before the page
 * credited them.
 *
 * GeoNames and Wikidata are credited in full on the setup screen rather than
 * here, where every extra word competes with the panorama.
 */
export default function AttributionBar({ location }: Props) {
  return (
    <div className="attribution">
      <span>Imagery by</span>
      <a
        href={`${ATTRIBUTION.mapillaryProfileUrlBase}${encodeURIComponent(location.creator)}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        {location.creator}
      </a>
      <span>·</span>
      <a href={ATTRIBUTION.imageLicenseUrl} target="_blank" rel="noreferrer noopener">
        {ATTRIBUTION.imageLicense}
      </a>
      <span>·</span>
      <a
        className="mapillary-mark"
        href={ATTRIBUTION.mapillaryUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        Mapillary
      </a>
      <span>·</span>
      <span>
        Places ©{' '}
        <a href={ATTRIBUTION.osmUrl} target="_blank" rel="noreferrer noopener">
          {ATTRIBUTION.osmName}
        </a>
      </span>
    </div>
  );
}
