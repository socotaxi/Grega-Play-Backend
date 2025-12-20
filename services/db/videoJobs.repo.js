import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function createVideoJob({ eventId, userId, requestedOptions, effectivePreset }) {
  const { data, error } = await supabase
    .from("video_jobs")
    .insert({
      event_id: eventId,
      user_id: userId,
      status: "queued",
      progress: 0,
      requested_options: requestedOptions || {},
      effective_preset: effectivePreset || {},
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function updateVideoJob(jobId, patch) {
  const { data, error } = await supabase
    .from("video_jobs")
    .update(patch)
    .eq("id", jobId)
    .select("*")
    .single();

  if (error) throw error;
  return data;

  const p = { ...(patch || {}) };

  // mapping camelCase -> snake_case
  if (p.outTimeSec !== undefined) {
    p.out_time_sec = p.outTimeSec;
    delete p.outTimeSec;
  }
  if (p.updatedAt !== undefined) {
    p.updated_at = p.updatedAt;
    delete p.updatedAt;
  }
// ... puis ton update supabase habituel
  return supabase.from("video_jobs").update(p).eq("id", jobId);

}

export async function getVideoJob(jobId) {
  const { data, error } = await supabase
    .from("video_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (error) throw error;
  return data;
}
