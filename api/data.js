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
                               : null;
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

    // Pull the whole database (full mirror).
    const [profilesQ, couponsQ, spotsQ, bookingsQ] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('floor_coupons').select('*'),
      supabase.from('spots').select('*'),
      supabase.from('bookings').select('*, booking_media(*)'),
    ]);

    for (const q of [profilesQ, couponsQ, spotsQ, bookingsQ]) {
      if (q.error) throw q.error;
    }

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
        is_active:    playable,         // Unreal: only play when true
      };
    });

    // Optional server-side filters (this is what Unreal calls with).
    if (user_id)    bookings = bookings.filter((b) => b.user_id === user_id);
    if (floor_type) bookings = bookings.filter((b) => b.floor_type === floor_type);

    // user_id ALSO narrows profiles + coupons, so a login lookup returns
    // exactly that one user — no other users' emails ever leave the server.
    let profiles = profilesQ.data;
    let coupons  = couponsQ.data;
    if (user_id) {
      profiles = profiles.filter((p) => p.id === user_id);
      coupons  = coupons.filter((c) => c.user_id === user_id);
    }

    return res.status(200).json({
      generated_at: now.toISOString(),
      filters: { user_id: user_id || null, floor_type: floor_type || null },
      counts: {
        profiles: profiles.length,
        coupons:  coupons.length,
        spots:    spotsQ.data.length,
        bookings: bookings.length,
      },
      profiles,
      floor_coupons: coupons,
      spots:         spotsQ.data,
      bookings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
