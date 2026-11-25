
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        success: false,
        error: "Supabase environment variables missing"
      });
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 50, 1),
      100
    );

    const response = await fetch(
      `${supabaseUrl}/rest/v1/telemetry?select=*&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Supabase error:", result);
      return res.status(500).json({
        success: false,
        error: "Failed to retrieve telemetry"
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
