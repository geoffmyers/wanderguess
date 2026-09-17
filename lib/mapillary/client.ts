/**
 * Resolves a Mapillary image ID to a usable panorama URL at play time.
 *
 * The manifest deliberately stores only IDs. Mapillary's thumbnail URLs are
 * signed CDN links whose expiry behaviour is undocumented, so baking them into
 * a committed manifest would risk a pool that silently rots.
 *
 * The token is public by design - it is the same class of client token
 * MapillaryJS ships in the browser - so it lives in NEXT_PUBLIC_.
 */

const GRAPH_URL = 'https://graph.mapillary.com';

export class MapillaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapillaryError';
  }
}

export function hasMapillaryToken(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_MAPILLARY_TOKEN);
}

export async function resolveImageUrl(
  imageId: string,
  signal?: AbortSignal
): Promise<string> {
  const token = process.env.NEXT_PUBLIC_MAPILLARY_TOKEN;
  if (!token) {
    throw new MapillaryError(
      'NEXT_PUBLIC_MAPILLARY_TOKEN is not set - cp .env.example to .env and set your token'
    );
  }

  const url = `${GRAPH_URL}/${encodeURIComponent(imageId)}?fields=thumb_2048_url`;
  const response = await fetch(url, {
    headers: { Authorization: `OAuth ${token}` },
    signal,
  });

  if (!response.ok) {
    throw new MapillaryError(
      `Mapillary returned ${response.status} for image ${imageId}`
    );
  }

  const data = (await response.json()) as { thumb_2048_url?: string };
  if (!data.thumb_2048_url) {
    throw new MapillaryError(`No panorama URL returned for image ${imageId}`);
  }
  return data.thumb_2048_url;
}

/**
 * Loads an image with CORS enabled. WebGL upload goes through an intermediate
 * canvas, which would be tainted - and throw on texImage2D - without this.
 */
export function loadCorsImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';

    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
    };

    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new MapillaryError(`Failed to load panorama image: ${url}`));
    };

    signal?.addEventListener('abort', () => {
      cleanup();
      image.src = '';
      reject(new DOMException('Aborted', 'AbortError'));
    });

    image.src = url;
  });
}
