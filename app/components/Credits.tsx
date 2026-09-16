'use client';

import { ATTRIBUTION } from '@/lib/game/constants';

/**
 * Who made this and what it is made of.
 *
 * The game board carries the short form, because a per-round bar has to stay
 * out of the way of the panorama. This is the full list, and two entries on it
 * are legal requirements rather than courtesies: GeoNames is CC BY 4.0 and
 * supplies every wrong answer the game offers, and OpenStreetMap is ODbL, which
 * requires its contributors to be credited wherever their data appears - which
 * now includes every street name in the game.
 */
export default function Credits() {
  return (
    <div className="section credits">
      <span className="section-label">Credits</span>

      <p className="credits-author">
        Built by{' '}
        <a href={ATTRIBUTION.authorUrl} target="_blank" rel="noreferrer noopener">
          {ATTRIBUTION.author}
        </a>
      </p>

      <ul className="credits-list">
        {ATTRIBUTION.sources.map((source) => (
          <li key={source.name}>
            <a href={source.url} target="_blank" rel="noreferrer noopener">
              {source.name}
            </a>{' '}
            <a
              className="credits-license"
              href={source.licenseUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {source.license}
            </a>
            <span className="credits-what"> — {source.what}</span>
          </li>
        ))}
      </ul>

      <p className="credits-software">
        Built with{' '}
        {ATTRIBUTION.software.map((project, index) => (
          <span key={project.name}>
            {index > 0 && ', '}
            <a href={project.url} target="_blank" rel="noreferrer noopener">
              {project.name}
            </a>
          </span>
        ))}
        {' '}— all MIT licensed.
      </p>
    </div>
  );
}
