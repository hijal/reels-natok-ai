# Custom MiniMax Studio Nodes

Copies of the studio's custom nodes so they can be installed into any standalone ComfyUI setup.
Installation: copy the folders entirely into `<ComfyUI>/custom_nodes/` and restart
ComfyUI. No extra configuration is needed — the nodes will appear in the node
addition menu, all under the category **MiniMax Studio**, except sparse attention.

| Folder | Nodes | Purpose |
| --- | --- | --- |
| `minimax_studio_av_latent` | `Save AV Latent` / `Load AV Latent` (Minimax Studio) | Save and read H3 AV-latents (`{"samples": NestedTensor(video, audio)}`) to `output/<sub>/latents/<stem>.latent` (safetensors + JSON header). Enables Refine to start from sampler latents without re-encoding mp4 via VAE. `Load` path is relative to `output/`. |
| `minimax_studio_audio_trim` | `Audio Trim` / `Audio Gain` (Minimax Studio) | Trim and amplify audio references directly in the tensor without creating duplicate files in `input/`. `end_seconds = 0` means until end of file. |
| `minimax_studio_extend` | `Extend Keyframes` / `Extend Latent Lock` (MiniMax Studio) | Seamless extension: `ExtendKeyframes` inserts the previous clip's tail latent into conditioning via native H3 keyframe channel (video at frame 0, audio context at negative frame); `LatentLock` is a model wrapper that locks predictions in the overlap zone (replacing video-SetLatentNoiseMask; audio mask remains). Pure torch + ComfyUI API, no dependencies. |
| `MiniMaxSparseAttn` | `Model Sparse Attention (Sol-Attn)` | Sol-Attn (training-free sparse attention) for H3 on this ComfyUI build: patches the model via `optimized_attention_override`, short sequences remain dense, automatic fallback to dense if kernel is unavailable. |

Dependencies:

- `minimax_studio_av_latent` — only `safetensors` (already in ComfyUI);
- `minimax_studio_audio_trim` — none, pure torch;
- `minimax_studio_extend` — none, pure torch + `comfy.nested_tensor`;
- `MiniMaxSparseAttn` — `comfy_kitchen` with `sol_attn` (included in this build). On
  another ComfyUI without it, the node simply does not patch the model — generation runs dense.

Details for each node can be found in the header of its `__init__.py`.
