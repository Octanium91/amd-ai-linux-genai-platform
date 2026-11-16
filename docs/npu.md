# Running the prompt assistant on the NPU

The Ryzen AI NPU (XDNA 2) can run the language model of the prompt assistant ("✦ Improve with AI", the scenes of long videos) instead of the GPU. Images, video and audio are still generated on the GPU: nothing for diffusion models runs on an NPU under Linux.

What it gives, measured on the reference machine ([models.md](models.md#where-the-model-runs)):

- the assistant takes no GPU memory (GTT) and keeps its speed while a generation runs;
- a prompt in 7–10 s, a five-part storyboard in 24 s with Qwen3 4B (about 20 tokens per second);
- a generation running at the same time is slowed the least (by 40% while the model answers, against 45% on the GPU and 56% on the processor).

What it costs: the FastFlowLM server keeps its model loaded, **8.4 GB of RAM (7.2 GB of it pinned) with `qwen3:4b` for as long as the container runs**, and the setup below. Without an NPU the assistant works as before, on the GPU through Ollama.

This was done once, on the reference machine (Sapphire EDGE AI 370, Ryzen AI 9 HX 370, Debian 13, November 2026). Steps for other distributions are quoted from the FastFlowLM and Lemonade documentation and marked as not tested here.

## What you need

| | |
|---|---|
| NPU | XDNA 2: Strix Point, Strix Halo, Krackan Point (PCI id `1022:17f0`). The first XDNA (`1022:1502`, Ryzen 7040/8040) is not supported by the Linux runtimes |
| Kernel | 7.0 or newer. The `amdxdna` driver is in the kernel since 6.14, but FastFlowLM asks for 7.0 (or the `amdxdna-dkms` backport) |
| Firmware | NPU firmware 1.1.0.0 or newer (linux-firmware 20260221 or newer) |
| RAM | about 8.4 GB for the server with the default model, on top of what generation needs |
| Docker | the same Docker that runs the platform |

XRT (AMD's runtime) and FastFlowLM itself live in the container: nothing but the kernel and the firmware is installed on the host.

## 1. Check the chip

```bash
lspci -nn | grep -i "neural\|17f0\|1502"
```

A line with `[1022:17f0]` is an XDNA 2 NPU. The platform shows the same on **Admin → System**, in the **NPU (XDNA)** line of the system check, together with what is missing.

## 2. Kernel 7.0 or newer

Check: `uname -r`.

**Debian 13** ships 6.12; a 7.x kernel is in backports:

```bash
echo "deb http://deb.debian.org/debian trixie-backports main contrib non-free non-free-firmware" | sudo tee /etc/apt/sources.list.d/backports.list
sudo apt update
sudo apt install -t trixie-backports linux-image-amd64 firmware-amd-graphics
sudo reboot
```

The old kernel stays installed and can be chosen in the GRUB menu ("Advanced options"). The kernel parameters for the GPU memory (`amdgpu.gttsize`, `ttm.pages_limit`, see [hardware.md](hardware.md#memory-uma-gtt-and-the-vulkan-heap)) are kept. On the reference machine generation ran at the same speed on 7.2.12 as on 6.12.117 (Wan 2.2 5B Turbo sampling 67.2 s and 65.5 s).

**Other distributions** (not tested here): Ubuntu 26.04 and current Arch ship a 7.x kernel. For Ubuntu 24.04 and 25.10 the Lemonade documentation gives `sudo add-apt-repository ppa:lemonade-team/stable` and `sudo apt install amdxdna-dkms`.

## 3. Check that the NPU started

```bash
ls -l /dev/accel/accel0
cat /sys/bus/pci/devices/*/fw_version 2>/dev/null
```

Expected: a device node owned by `root:render`, and a firmware version of 1.1.0.0 or newer (the reference machine: `1.1.2.64`). On the System page the NPU line turns green: "The XDNA 2 NPU works: …".

If the node is missing, see [If it does not work](#if-it-does-not-work).

## 4. Start the FastFlowLM server

[extras/fastflowlm](../extras/fastflowlm) has the image (Debian 13, XRT from backports, the FastFlowLM package from its GitHub releases) and a compose file. From the platform directory:

```bash
docker compose -f extras/fastflowlm/docker-compose.yml up -d --build
```

Or add the service to a compose file you already have (the one that runs Ollama, for example): copy the `extras/fastflowlm` directory next to it and paste the service from `compose.snippet.yml`.

What the service needs, whichever way it is started:

- `devices: /dev/accel/accel0` — the NPU;
- `ulimits: memlock: -1` — FastFlowLM pins the model's memory;
- port `52625` — the server's API;
- a volume for `/root/.config/flm` — the downloaded models.

On first start the server downloads its model (`qwen3:4b`, 3.1 GB); the container is "starting" until then. Check:

```bash
docker exec fastflowlm flm validate
curl -s http://localhost:52625/v1/models | head -c 200
```

`flm validate` should print the kernel, `NPU: /dev/accel/accel0 with 8 columns`, the firmware version, the `amdxdna` version and `Memlock Limit: infinity`.

## 5. Turn it on in the platform

**Admin → Settings → Prompt assistant**:

1. tick **Enable the prompt assistant**;
2. **Where the language model runs**: **Automatic** (the NPU when its server answers, the GPU otherwise) or **NPU**;
3. **FastFlowLM server address**: `http://host.docker.internal:52625` when the server runs on the same machine; press **Check** — "FastFlowLM answers: N models available";
4. **Model on the NPU**: `qwen3:4b`;
5. **Save**.

With **Automatic** the Ollama fields stay in use as the fallback, so leave them filled in.

## 6. Check that it works

- Type an idea into the prompt box of **Create** and press **✦ Improve with AI**: the prompt comes back in about 10 s.
- While it answers, the **NPU** block of the system bar (System page) shows "100% · working"; idle it shows "0% · idle". The load is the share of time the kernel kept the NPU powered, and the NPU powers down 5 s after its last work, so it stays at 100% for a few seconds after an answer.
- For a long video, **Write the scenes with AI** (or just **Generate** with empty scenes) uses the same model.

## Choosing a model

The server downloads a model the first time it is asked for it, so changing **Model on the NPU** in Settings is enough; the first answer then waits for the download. The list:

```bash
docker exec fastflowlm flm list
```

`FLM_MODEL` in the compose file is only the model the server loads at start. Measured on the reference machine:

| Model | Speed | Notes |
|---|---|---|
| `qwen3:4b` | about 20 tokens/s | the default; a prompt in 7–10 s, five scenes in 24 s |
| `gemma4-it:12b` | 7.0 tokens/s | 8.6 GB of RAM; the same model through Ollama gave 15.6 tokens/s on the GPU and 12.3 on the processor |

A light model is the point: the assistant's answers are short, and a larger model is both slower and heavier. Thinking models are asked not to think (a reasoning trace took 10 s before a two-line answer).

## If it does not work

**The System page says the driver is not loaded.** The kernel is older than 6.14 or has no `amdxdna` module: step 2. Check with `lsmod | grep amdxdna`.

**It says the driver is loaded but the NPU did not start.** Usually the firmware is missing or too old: install `firmware-amd-graphics` from backports (Debian) or update linux-firmware, reboot, and look at `sudo dmesg | grep -i xdna`. The firmware files are in `/lib/firmware/amdnpu/17f0_10/` on the reference machine (the directory is named after the PCI id and revision). The FastFlowLM documentation warns not to boot with `amd_iommu=off`, and that forcing the 1.1 firmware onto a kernel older than 7.0 can make the NPU disappear.

**It says kernel 7.0 is needed.** The driver of kernels 6.14–6.19 runs the NPU but lacks what FastFlowLM uses: step 2.

**The container restarts, or `flm validate` fails.** Check that the service has the `devices` and `ulimits` lines of step 4 and that `/dev/accel/accel0` exists on the host. `docker logs fastflowlm` shows the reason.

**Settings: "The FastFlowLM server is not reachable".** The container is not running (`docker ps`), still downloading its model (`docker logs -f fastflowlm`), or the address is wrong. `host.docker.internal` works because the platform's `web` service maps it to the Docker host (`extra_hosts` in `docker-compose.yml`); a server on another machine needs that machine's address, and a firewall on the host must let the Docker network reach port 52625.

**"The FastFlowLM server does not know this model".** The name must be one of `flm list`, tag included (`qwen3:4b`, not `qwen3`).

**The first answer takes minutes or "did not answer in time".** A model that is not downloaded yet is being fetched: wait for it in `docker logs -f fastflowlm` and try again.

**With Automatic the assistant still runs on the GPU.** The server did not answer when the platform checked (it checks at most every 30 s). **Check** in Settings asks it again.

**Generation is slower while the assistant works.** Expected: the NPU, the GPU and the processor share one APU's memory and power. On the NPU the slowdown is the smallest of the three.

## Security

Like Ollama's, the FastFlowLM port has no authentication: anyone who can reach port 52625 can use the model. Binding it to `127.0.0.1` would also hide it from the platform's container, which reaches it through the Docker host address; keep the machine on a trusted network or close the port to other hosts with a firewall.

## Removing it

Switch **Where the language model runs** to **GPU**, then `docker compose -f extras/fastflowlm/docker-compose.yml down` (or remove the service from your compose file). The models are in the `flm_data` directory next to the compose file. The kernel can stay.
