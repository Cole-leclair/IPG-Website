// Serves IPG's Google reviews to the website. The page fetches this on load.
// Response is cached at Netlify's edge for ~1 week, so Google's API is only
// queried about once a week (stays well within free usage and Google's terms).
//
// -------------------------------------------------------------------------
// Set these in Netlify > Site configuration > Environment variables:
//     GOOGLE_PLACES_API_KEY   API key from Google Cloud (Places API enabled)
//     GOOGLE_PLACE_ID         the Place ID for the IPG Google listing
// Until both are set, this returns {configured:false} and the page shows its
// default summary + "Read our reviews on Google" button (no broken UI).
// -------------------------------------------------------------------------

exports.handler = async function () {
  var headers = {
    "Content-Type": "application/json",
    // Browser caches 1h; Netlify's edge caches 1 week and refreshes in the
    // background, so real visitors are fast and Google is hit ~weekly.
    "Cache-Control": "public, max-age=3600",
    "Netlify-CDN-Cache-Control": "public, s-maxage=604800, stale-while-revalidate=86400"
  };

  var KEY = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  var PLACE = (process.env.GOOGLE_PLACE_ID || "").trim();
  if (!KEY || !PLACE) {
    return { statusCode: 200, headers: headers, body: JSON.stringify({ configured: false }) };
  }

  try {
    var url = "https://places.googleapis.com/v1/places/" + encodeURIComponent(PLACE);
    var res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "rating,userRatingCount,googleMapsUri,reviews"
      }
    });
    if (!res.ok) {
      console.error("Places API error:", res.status, await res.text());
      return { statusCode: 200, headers: headers, body: JSON.stringify({ configured: true, error: res.status }) };
    }
    var d = await res.json();
    var reviews = (d.reviews || []).map(function (rv) {
      return {
        name: (rv.authorAttribution && rv.authorAttribution.displayName) || "Google user",
        rating: rv.rating || 5,
        when: rv.relativePublishTimeDescription || "",
        text: (rv.text && rv.text.text) || (rv.originalText && rv.originalText.text) || ""
      };
    }).filter(function (r) { return r.text; });

    var payload = {
      configured: true,
      rating: d.rating != null ? d.rating : null,
      total: d.userRatingCount != null ? d.userRatingCount : null,
      url: d.googleMapsUri || null,
      reviews: reviews
    };
    return { statusCode: 200, headers: headers, body: JSON.stringify(payload) };
  } catch (err) {
    console.error("reviews function error:", err);
    return { statusCode: 200, headers: headers, body: JSON.stringify({ configured: true, error: "exception" }) };
  }
};
