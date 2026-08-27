export default {
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_WITH_YOUR_PROJECT_REF",
  dirs: ["./src/trigger"],
  maxDuration: 300,
};
