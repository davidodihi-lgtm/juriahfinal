JURIAH MONIQUE ADORNMENTS — SITE FILES
index.html  = the shop (reads products live from Supabase)
admin.html  = owner login page (yoursite.com/admin.html)
config.js   = Supabase URL + publishable key
images/     = starting product photos
setup.sql   = run once in Supabase > SQL Editor
Upload this whole folder to Cloudflare Pages / Netlify. Keep the folder structure.
success.html = page shown after a successful payment
api/create-checkout.js, api/stripe-webhook.js = Vercel functions (Stripe)
orders.sql = run once in Supabase SQL Editor
.env.example = list of environment variables to add in Vercel
