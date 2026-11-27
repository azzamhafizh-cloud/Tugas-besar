
export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      success: false,
      error: "Supabase environment variables missing"
    });
  }

  const deviceId = "ESP32-AIRWATCH";

  const allowedFields = [
    "max_temperature",
    "min_humidity",
    "max_humidity",
    "max_pm1",
    "max_pm25",
    "max_pm10",
    "max_gas_raw",
    "gas_alarm_enabled"
  ];

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json"
  };

  try {
    if (req.method === "GET") {
      const url = new URL(
        `${supabaseUrl}/rest/v1/device_config`
      );

      url.searchParams.set("select", allowedFields.join(","));
      url.searchParams.set("device_id", `eq.${deviceId}`);
      url.searchParams.set("limit", "1");

      const response = await fetch(url, { headers });
      const result = await response.json();

      if (!response.ok) {
        console.error("Config GET error:", result);

        return res.status(500).json({
          success: false,
          error: "Failed to retrieve device configuration"
        });
      }

      return res.status(200).json({
        success: true,
        data: result[0] || null
      });
    }

    if (req.method === "POST") {
      const updates = {};

      for (const field of allowedFields) {
        if (req.body?.[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          success: false,
          error: "No valid configuration fields provided"
        });
      }

      for (const field of allowedFields) {
        if (
          field !== "gas_alarm_enabled" &&
          updates[field] !== undefined &&
          updates[field] !== null
        ) {
          const value = Number(updates[field]);

          if (!Number.isFinite(value)) {
            return res.status(400).json({
              success: false,
              error: `Invalid value for ${field}`
            });
          }

          updates[field] = value;
        }
      }

      if (
        updates.gas_alarm_enabled !== undefined &&
        typeof updates.gas_alarm_enabled !== "boolean"
      ) {
        return res.status(400).json({
          success: false,
          error: "gas_alarm_enabled must be boolean"
        });
      }

      const url = new URL(
        `${supabaseUrl}/rest/v1/device_config`
      );

      url.searchParams.set("device_id", `eq.${deviceId}`);

      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify(updates)
      });

      const result = await response.json();

      if (!response.ok) {
        console.error("Config POST error:", result);

        return res.status(500).json({
          success: false,
          error: "Failed to update device configuration"
        });
      }

      if (!result || result.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Device configuration not found"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Device configuration updated",
        data: result[0]
      });
    }

    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });

  } catch (error) {
    console.error("Config API error:", error);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
