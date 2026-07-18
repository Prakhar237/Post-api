// ============================================================
//  BRIDGE ENDPOINT  ->  /api/data
//  Mirrors Supabase data as Unreal/VArest-friendly JSON.
//
//  Runs SERVER-SIDE on Vercel. The service key lives in an
//  environment variable and is NEVER sent to the browser.
//
//  Usage from Unreal (VArest GET):
//    /api/data                          -> full mirror (everything)
//    /api/data?user_id=<uuid>           -> only that user's bookings
//    /api/data?user_id=<uuid>&floor_type=ground
//    /api/data?floor_type=virtual
// ============================================================

import { createClient } from '@supabase/supabase-js';

// SUPABASE_URL is public (it's already in your front-end), safe to hardcode.
const SUPABASE_URL = 'https://tlmhonuejcubyhzihjwv.supabase.co';

// SERVICE KEY: set this in Vercel -> Project -> Settings -> Environment
// Variables as  SUPABASE_SERVICE_KEY.  Do NOT paste it into index.html.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Turn a Storage path ("userid/123_file.png") into a public URL.
// Requires the bucket to be public; for private buckets use signed URLs instead.
function publicUrl(bucket, path) {
  if (!path) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

// Resolve the single content URL Unreal should play, based on upload_type.
function resolveContentUrl(b, media) {
  if (!media) return null;
  switch (b.upload_type) {
    case 'video':      return media.youtube_url || null;
    case 'image':      return media.image_file_path
                               ? publicUrl('images', media.image_file_path)
                               : (media.custom_url || null);
    case '3d_model':   return media.model_file_path
                               ? publicUrl('models', media.model_file_path)
                               : (media.custom_url || null);
    case 'custom_url': return media.custom_url || null;
    default:           return media.youtube_url || media.custom_url || null;
  }
}

export default async function handler(req, res) {
  // Allow Unreal / any origin to read it; this endpoint is read-only.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!SERVICE_KEY) {
    return res.status(500).json({
      error: 'SUPABASE_SERVICE_KEY is not set. Add it in Vercel project settings.',
    });
  }

  try {
    const { user_id, floor_type } = req.query;

    // HARD GATE: no UUID -> no data at all. The bridge only answers
    // per-user queries; an empty or missing user_id returns nothing.
    if (!user_id || !String(user_id).trim()) {
      return res.status(400).json({
        error: 'user_id is required',
        generated_at: new Date().toISOString(),
        filters: { user_id: null, floor_type: floor_type || null },
        counts: { profiles: 0, coupons: 0, spots: 0, bookings: 0 },
        profiles: [],
        floor_coupons: [],
        spots: [],
        bookings: [],
      });
    }

    // Only bookings are ever returned, so only bookings are queried.
    const bookingsQ = await supabase.from('bookings').select('*, booking_media(*)');
    if (bookingsQ.error) throw bookingsQ.error;

    const now = new Date();

    // Flatten bookings into a flat shape VArest can read without nested parsing.
    let bookings = bookingsQ.data.map((b) => {
      const media = Array.isArray(b.booking_media)
        ? b.booking_media[0]
        : b.booking_media;
      const expired = b.expires_at ? new Date(b.expires_at) < now : false;
      // Ground floor needs admin approval; virtual floor plays without it.
      const playable = (b.floor_type === 'virtual' ? true : !!b.approved) && !expired;
      return {
        booking_id:   b.id,
        user_id:      b.user_id,
        spot_id:      b.spot_numbers,   // matches the Actor Tag in Unreal
        floor_number: b.floor_number,
        floor_type:   b.floor_type,     // 'ground' | 'virtual'
        content_type: b.upload_type,    // 'video' | 'image' | '3d_model' | 'custom_url'
        content_url:  resolveContentUrl(b, media),
        preview_url:  media && media.model_preview_path
                        ? publicUrl('images', media.model_preview_path)
                        : null,
        side_url:     media ? (media.side_button_url || null) : null,
        approved:     b.approved,
        expires_at:   b.expires_at,
        submitted_at: b.submitted_at,   // used to pick the latest per spot
        is_active:    playable,         // Unreal: only play when true
      };
    });

    // Optional server-side filters (this is what Unreal calls with).
    if (user_id)    bookings = bookings.filter((b) => b.user_id === user_id);
    if (floor_type) bookings = bookings.filter((b) => b.floor_type === floor_type);

    // Collapse to ONE EFFECTIVE booking per spot (per user + floor).
    // Rule: the latest-submitted booking that is currently playable wins.
    // If none is playable, keep the latest-submitted row but is_active=false,
    // so Unreal knows to CLEAR that spot (covers graceful handover + takedown).
    // This is what implements "one effective approved booking per spot": during
    // the pending window the old APPROVED row is still playable and beats the new
    // pending one; once the new row is approved, both are playable so newest wins.
    const bySpot = new Map();
    for (const b of bookings) {
      const key = `${b.user_id}|${b.floor_type}|${b.spot_id}`;
      const cur = bySpot.get(key);
      if (!cur) { bySpot.set(key, b); continue; }
      const bT = new Date(b.submitted_at).getTime();
      const cT = new Date(cur.submitted_at).getTime();
      const bBetter =
        (b.is_active && !cur.is_active) ||                 // playable beats non-playable
        (b.is_active === cur.is_active && bT > cT);        // else newest wins
      if (bBetter) bySpot.set(key, b);
    }
    bookings = Array.from(bySpot.values());

    // BOOKINGS-ONLY policy: with a valid user_id the bridge returns ONLY that
    // user's effective bookings. Profiles, coupons, and the global spot catalog
    // are never exposed (login gets floor/coupon via the in-page hash instead).
    // Keys are kept as empty arrays so existing VaRest parsing never breaks.
    return res.status(200).json({
      generated_at: now.toISOString(),
      filters: { user_id: user_id || null, floor_type: floor_type || null },
      counts: {
        profiles: 0,
        coupons:  0,
        spots:    0,
        bookings: bookings.length,
      },
      profiles:      [],
      floor_coupons: [],
      spots:         [],
      bookings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
