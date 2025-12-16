// backend/repos/videoJobs.repo.js

export default function createVideoJobsRepo(supabase) {
  return {
    async createJob({
      eventId,
      userId,
      selectedVideoIds = [],
      status = "queued",
      requestedOptions = null,
      effectivePreset = null,
    }) {
      const payload = {
        event_id: eventId,
        user_id: userId,
        status,
        selected_video_ids: selectedVideoIds,
        requested_options: requestedOptions,
        effective_preset: effectivePreset,
      };

      const { data, error } = await supabase
        .from("video_jobs")
        .insert(payload)
        .select("*")
        .single();

      if (error) throw error;
      return data;
    },

    async updateJob(jobId, patch = {}) {
      const { data, error } = await supabase
        .from("video_jobs")
        .update(patch)
        .eq("id", jobId)
        .select("*")
        .single();

      if (error) throw error;
      return data;
    },

    async getJob(jobId) {
      const { data, error } = await supabase
        .from("video_jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (error) throw error;
      return data;
    },

    async listJobsByEvent(eventId, limit = 20) {
      const { data, error } = await supabase
        .from("video_jobs")
        .select("*")
        .eq("event_id", eventId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    },
  };
}
