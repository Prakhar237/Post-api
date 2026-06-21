# Unreal ↔ Supabase JSON Bridge (Vercel)

A read-only bridge that mirrors your Supabase data as flat JSON for Unreal Engine
to read with VArest. The Supabase **service key stays server-side** — it is never
exposed in the browser.

## What's inside

```
bridge-vercel/
├── api/
│   └── data.js        ← serverless function: queries Supabase, returns JSON
├── index.html         ← live viewer (reads /api/data only, no key in browser)
├── package.json
└── README.md
```

## Deploy (3 steps)

1. Push this folder to a GitHub repo (or drag it into the Vercel dashboard).
2. Import it on https://vercel.com — Vercel auto-detects `/api` and `index.html`,
   no extra config needed.
3. Add ONE environment variable in **Vercel → Project → Settings → Environment
   Variables**:

   ```
   Name:   SUPABASE_SERVICE_KEY
   Value:  <your Supabase service_role key>
   ```
   Get it from Supabase → Project Settings → API → `service_role` (secret).
   Redeploy after adding it.

> Do NOT paste the service key into `index.html` or `api/data.js` directly.
> Keep it in the env var so it never reaches the browser.

## Endpoints (use these in Unreal VArest)

```
GET  /api/data                                  full mirror (everything)
GET  /api/data?user_id=<uuid>                   one user's bookings only
GET  /api/data?user_id=<uuid>&floor_type=ground ground-floor, one user
GET  /api/data?floor_type=virtual               all virtual-floor bookings
```

### Booking fields Unreal reads

| field        | meaning                                            |
|--------------|----------------------------------------------------|
| spot_id      | matches the Actor Tag on the mesh (`SP-01`)        |
| floor_type   | `ground` or `virtual`                              |
| content_type | `video` / `image` / `3d_model` / `custom_url`      |
| content_url  | the single URL to play / load                      |
| preview_url  | 3D-model PNG preview (else null)                   |
| side_url     | the `?` mesh link (else null)                      |
| is_active    | **only play when true** (approved + not expired)   |
| expires_at   | when the booking stops being active                |

## Notes

- `is_active` already bakes in the rule: ground floor needs `approved = true`,
  virtual floor plays without approval; both must be unexpired.
- Image / 3D-model file paths are returned as **public Storage URLs**. Make the
  `images` and `models` buckets public, or switch `publicUrl()` to signed URLs.
- The 10s refresh in `index.html` is only for the human viewing the page. Unreal
  gets fresh data on every VArest call regardless — there is no cached file.
