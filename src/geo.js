// Geohash + geocoding helpers.
// Relay tag filters are exact-match only, so a publisher has to emit several
// geohash precisions and a reader has to ask for several prefixes.

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz'

export function encodeGeohash(lat, lon, precision = 9) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180
  let hash = '', bit = 0, ch = 0, even = true
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2
      if (lon > mid) { ch = (ch << 1) + 1; lonMin = mid } else { ch = ch << 1; lonMax = mid }
    } else {
      const mid = (latMin + latMax) / 2
      if (lat > mid) { ch = (ch << 1) + 1; latMin = mid } else { ch = ch << 1; latMax = mid }
    }
    even = !even
    if (++bit === 5) { hash += B32[ch]; bit = 0; ch = 0 }
  }
  return hash
}

export function decodeGeohash(hash) {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, even = true
  for (const c of String(hash).toLowerCase()) {
    const idx = B32.indexOf(c)
    if (idx < 0) return null
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1
      if (even) {
        const mid = (lonMin + lonMax) / 2
        if (bit) lonMin = mid; else lonMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if (bit) latMin = mid; else latMax = mid
      }
      even = !even
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 }
}

// All prefixes of a geohash, coarse to fine. Publishing every precision makes
// "near me" one cheap exact-match filter for any reader.
export function geohashPrefixes(hash, min = 1, max = 9) {
  const out = []
  for (let i = min; i <= Math.min(max, hash.length); i++) out.push(hash.slice(0, i))
  return out
}

export function haversineKm(a, b) {
  if (!a || !b) return null
  const R = 6371, toRad = d => d * Math.PI / 180
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon)
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Photon (komoot). Open CORS, no key, OSM data.
export async function geocodeCity(q, { signal } = {}) {
  const url = 'https://photon.komoot.io/api/?limit=6&q=' + encodeURIComponent(q)
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error('geocoder http ' + res.status)
  const data = await res.json()
  return (data.features || [])
    .filter(f => ['city', 'town', 'village', 'district', 'state', 'locality'].includes(f.properties.type) ||
      f.properties.osm_value === 'city' || f.properties.osm_value === 'town')
    .map(f => ({
      name: f.properties.name,
      country: f.properties.country,
      state: f.properties.state,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
}

export async function geocodePlace(q, { signal } = {}) {
  const url = 'https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(q)
  const res = await fetch(url, { signal })
  if (!res.ok) return null
  const data = await res.json()
  const f = (data.features || [])[0]
  if (!f) return null
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: f.properties.name }
}
