Read a text file from the local filesystem.

The path may be a `kimi-file://` attachment reference. Its bytes come from the current session's storage, independently of the workspace runtime. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem.

If the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Relative paths resolve against the working directory; a path outside the working directory must be absolute.
- Output is `<line-number>\t<content>` per line. A `<system>` status block may follow; it is not part of the file.
- Results are bounded by `max_chars`: ${DEFAULT_MAX_CHARS} by default, up to ${MAX_CHARS}, and by about ${MAX_CHARS} divided by four estimated tokens.
- If the status block reports an incomplete range, continue with its `Next Read` arguments exactly. Do not answer from a partial page when the task requires the remaining content.
- **Images and videos** (max ${MAX_MEDIA_MEGABYTES}MB) are sent to the model as multimodal media instead of text; this requires a model with the matching vision capability (`image_in` / `video_in`). `region` and `full_resolution` apply only to images; `line_offset` and `n_lines` apply only to text files.
- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the `<system>` block, never by measuring the displayed copy. When the `<system>` tag reports downsampling and you need that detail, call Read again with the `region` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set `full_resolution` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.
- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed.
