require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { del, list, put } = require("@vercel/blob");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const prisma = new PrismaClient();
const port = Number(process.env.PORT) || 3000;

function parseValor(valor) {
  const texto = String(valor ?? "")
    .trim()
    .replace(/\s/g, "");
  if (!texto) return NaN;
  const normalizado = texto.includes(",")
    ? texto.replace(/\./g, "").replace(",", ".")
    : texto;
  return Number(normalizado);
}

function databaseError(error) {
  if (error?.code === "P1001" || error?.code === "P1012") {
    return "Banco de dados inacessivel. Substitua DATABASE_URL no arquivo .env pela URL real do Neon e reinicie o servidor.";
  }
  return "Nao foi possivel concluir a operacao no banco de dados.";
}

app.use(cors());
app.use(express.json());
const publicDirectory = path.join(__dirname, "public");
app.use(express.static(publicDirectory));

const uploadDirectory = path.join(publicDirectory, "uploads");
const useBlobStorage = Boolean(
  process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL,
);
if (!useBlobStorage) fs.mkdirSync(uploadDirectory, { recursive: true });
const upload = multer({
  storage: useBlobStorage
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: uploadDirectory,
        filename: (req, file, callback) => {
          const extension = path.extname(file.originalname).toLowerCase();
          callback(
            null,
            `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
          );
        },
      }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    callback(null, /^(image|video)\//.test(file.mimetype));
  },
});

function mediaType(file) {
  return file.mimetype.startsWith("video/") ? "video" : "image";
}

function mediaUrl(file) {
  return `/uploads/${file.filename}`;
}

async function storeFile(file) {
  if (!useBlobStorage) {
    return {
      filename: file.filename,
      source: mediaUrl(file),
      size: file.size,
      updatedAt: new Date(),
    };
  }
  const extension = path.extname(file.originalname).toLowerCase();
  const blob = await put(
    `uploads/${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`,
    file.buffer,
    { access: "public", contentType: file.mimetype },
  );
  return {
    filename: path.basename(blob.pathname),
    source: blob.url,
    size: file.size,
    updatedAt: new Date(),
  };
}

async function storedFiles() {
  if (useBlobStorage) {
    const result = await list();
    return result.blobs.map((blob) => ({
      filename: path.basename(blob.pathname),
      source: blob.url,
      type: uploadedFileType(blob.pathname),
      size: blob.size,
      updatedAt: blob.uploadedAt,
    }));
  }
  const filenames = await fs.promises.readdir(uploadDirectory);
  return Promise.all(
    filenames.map(async (filename) => {
      const stats = await fs.promises.stat(
        path.join(uploadDirectory, filename),
      );
      return {
        filename,
        source: mediaUrl({ filename }),
        type: uploadedFileType(filename),
        size: stats.size,
        updatedAt: stats.mtime,
      };
    }),
  );
}

function uploadedFileType(filename) {
  return /\.(mp4|webm|mov|m4v|avi)$/i.test(filename) ? "video" : "image";
}

async function rememberAsset(source, role) {
  return prisma.slideAsset.upsert({
    where: { source },
    update: { role },
    create: { source, role },
  });
}

app.get("/api/uploads", async (req, res) => {
  try {
    const [storedResult, scenesResult, assetsResult] = await Promise.allSettled(
      [
        storedFiles(),
        prisma.slideMedia.findMany({
          select: { source: true, overlaySource: true },
        }),
        prisma.slideAsset.findMany(),
      ],
    );
    const stored =
      storedResult.status === "fulfilled" ? storedResult.value : [];
    const scenes =
      scenesResult.status === "fulfilled" ? scenesResult.value : [];
    const assets =
      assetsResult.status === "fulfilled" ? assetsResult.value : [];
    if (
      scenesResult.status === "rejected" ||
      assetsResult.status === "rejected"
    ) {
      console.warn(
        "Banco indisponível ao listar uploads; retornando arquivos locais apenas.",
      );
    }
    const mainUsage = new Map();
    const backgroundUsage = new Map();
    const backgroundSources = new Set(
      assets
        .filter((asset) => asset.role === "background")
        .map((asset) => asset.source),
    );
    const sceneSources = new Set();
    for (const scene of scenes) {
      if (scene.source) {
        sceneSources.add(scene.source);
        mainUsage.set(scene.source, (mainUsage.get(scene.source) || 0) + 1);
      }
      if (scene.overlaySource) {
        sceneSources.add(scene.overlaySource);
        backgroundSources.add(scene.overlaySource);
        backgroundUsage.set(
          scene.overlaySource,
          (backgroundUsage.get(scene.overlaySource) || 0) + 1,
        );
      }
    }
    if (assetsResult.status === "fulfilled") {
      await Promise.all(
        [...backgroundSources].map((source) =>
          rememberAsset(source, "background").catch((error) => {
            console.warn(
              "Não foi possível registrar asset de background:",
              error,
            );
          }),
        ),
      );
    }
    const storedSources = new Set(stored.map((file) => file.source));
    const uploadFiles = stored.map((file) => ({
      ...file,
      usedBy:
        (mainUsage.get(file.source) || 0) +
        (backgroundUsage.get(file.source) || 0),
      mainUsedBy: mainUsage.get(file.source) || 0,
      backgroundUsedBy:
        backgroundUsage.get(file.source) ||
        (backgroundSources.has(file.source) ? 1 : 0),
      isBackground: backgroundSources.has(file.source),
      managed: true,
    }));
    const librarySources = [...sceneSources].filter(
      (source) => !storedSources.has(source),
    );
    const sceneFiles = await Promise.all(
      librarySources.map(async (source) => {
        const filePath = path.join(publicDirectory, source.replace(/^\/+/, ""));
        try {
          const stats = await fs.promises.stat(filePath);
          return {
            filename: path.basename(source),
            source,
            type: uploadedFileType(source),
            size: stats.size,
            usedBy:
              (mainUsage.get(source) || 0) + (backgroundUsage.get(source) || 0),
            mainUsedBy: mainUsage.get(source) || 0,
            backgroundUsedBy:
              backgroundUsage.get(source) ||
              (backgroundSources.has(source) ? 1 : 0),
            isBackground: backgroundSources.has(source),
            managed: false,
            updatedAt: stats.mtime,
          };
        } catch {
          return null;
        }
      }),
    );
    const files = [...uploadFiles, ...sceneFiles.filter(Boolean)];
    res.json(files.sort((left, right) => right.updatedAt - left.updatedAt));
  } catch (error) {
    console.error("Erro ao listar uploads:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.post("/api/slide/from-library", async (req, res) => {
  const source = String(req.body.source || "");
  const duration = Number(req.body.duration || 16);
  const relativeSource = source.replace(/^\/+/, "");
  const filePath = path.resolve(publicDirectory, relativeSource);
  if (
    !source.startsWith("/") ||
    relativeSource.includes("..") ||
    !filePath.startsWith(`${publicDirectory}${path.sep}`) ||
    !Number.isFinite(duration) ||
    duration < 1
  ) {
    return res.status(400).json({ error: "Mídia da biblioteca inválida." });
  }
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error("Arquivo inválido");
    const last = await prisma.slideMedia.findFirst({
      orderBy: { position: "desc" },
    });
    const media = await prisma.slideMedia.create({
      data: {
        position: (last?.position || 0) + 1,
        source,
        type: uploadedFileType(source),
        duration: Math.round(duration * 1000),
        fit: ["cover", "contain", "fill"].includes(req.body.fit)
          ? req.body.fit
          : "cover",
      },
    });
    await rememberAsset(media.source, "media");
    io.emit("SLIDE_ATUALIZADO");
    res.status(201).json(media);
  } catch (error) {
    console.error("Erro ao reutilizar mídia da biblioteca:", error);
    res.status(error.code === "ENOENT" ? 404 : 503).json({
      error:
        error.code === "ENOENT"
          ? "Arquivo não encontrado."
          : databaseError(error),
    });
  }
});

app.delete("/api/uploads/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename || filename !== req.params.filename) {
    return res.status(400).json({ error: "Arquivo inválido." });
  }
  try {
    const scenes = await prisma.slideMedia.findMany({
      where: {
        OR: [
          { source: `/uploads/${filename}` },
          { overlaySource: `/uploads/${filename}` },
        ],
      },
      select: { id: true },
    });
    if (scenes.length) {
      return res.status(409).json({
        error:
          "Este arquivo ainda está sendo usado por uma cena. Remova a cena primeiro.",
      });
    }
    const file = (await storedFiles()).find(
      (storedFile) => storedFile.filename === filename,
    );
    if (!file) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
    if (useBlobStorage) {
      await del(file.source);
    } else {
      await fs.promises.unlink(path.join(uploadDirectory, filename));
    }
    await prisma.slideAsset.deleteMany({ source: file.source });
    res.status(204).end();
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }
    console.error("Erro ao remover upload:", error);
    res.status(503).json({ error: "Não foi possível remover o arquivo." });
  }
});

app.get("/api/slide", async (req, res) => {
  try {
    let media = await prisma.slideMedia.findMany({
      orderBy: { position: "asc" },
    });
    if (!media.length) {
      const defaults = [
        ["/001.png", "image", 16, "contain"],
        ["/002.jpeg", "image", 32, "cover"],
        ["/003.mp4", "video", 20, "cover"],
        ["/004.jpeg", "image", 32, "cover"],
        ["/005.jpeg", "image", 16, "cover"],
        ["/007.jpeg", "image", 16, "cover"],
        ["/008.jpeg", "image", 17, "fill"],
        ["/010.png", "image", 16, "contain"],
        ["/011.jpeg", "image", 15, "cover"],
      ];
      await prisma.slideMedia.createMany({
        data: defaults.map(([source, type, duration, fit], position) => ({
          source,
          type,
          duration: duration * 1000,
          fit,
          position: position + 1,
        })),
      });
      media = await prisma.slideMedia.findMany({
        orderBy: { position: "asc" },
      });
    }
    res.json(media);
  } catch (error) {
    console.error("Erro ao buscar mídias do slide:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.post(
  "/api/slide",
  upload.fields([
    { name: "media", maxCount: 1 },
    { name: "overlay", maxCount: 1 },
  ]),
  async (req, res) => {
    const mediaFile = req.files?.media?.[0];
    const overlayFile = req.files?.overlay?.[0];
    const duration = Number(req.body.duration);
    if (!mediaFile || !Number.isFinite(duration) || duration < 1) {
      return res.status(400).json({
        error: "Envie uma mídia e uma duração de pelo menos 1 segundo.",
      });
    }
    try {
      const storedMedia = await storeFile(mediaFile);
      const storedOverlay = overlayFile ? await storeFile(overlayFile) : null;
      const last = await prisma.slideMedia.findFirst({
        orderBy: { position: "desc" },
      });
      const media = await prisma.slideMedia.create({
        data: {
          position: (last?.position || 0) + 1,
          type: mediaType(mediaFile),
          source: storedMedia.source,
          duration: Math.round(duration * 1000),
          fit: ["cover", "contain", "fill"].includes(req.body.fit)
            ? req.body.fit
            : "cover",
          overlaySource: storedOverlay?.source || null,
          overlayType: overlayFile ? mediaType(overlayFile) : null,
        },
      });
      await rememberAsset(media.source, "media");
      if (media.overlaySource)
        await rememberAsset(media.overlaySource, "background");
      io.emit("SLIDE_ATUALIZADO");
      res.status(201).json(media);
    } catch (error) {
      console.error("Erro ao criar mídia do slide:", error);
      res.status(503).json({ error: databaseError(error) });
    }
  },
);

app.patch("/api/slide/:id", async (req, res) => {
  const duration = Number(req.body.duration);
  if (!Number.isFinite(duration) || duration < 1) {
    return res.status(400).json({ error: "A duração mínima é de 1 segundo." });
  }
  try {
    const media = await prisma.slideMedia.update({
      where: { id: req.params.id },
      data: {
        duration: Math.round(duration * 1000),
        fit: ["cover", "contain", "fill"].includes(req.body.fit)
          ? req.body.fit
          : "cover",
      },
    });
    io.emit("SLIDE_ATUALIZADO");
    res.json(media);
  } catch (error) {
    console.error("Erro ao editar mídia do slide:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.post(
  "/api/slide/:id/overlay",
  upload.single("overlay"),
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "Escolha uma imagem ou vídeo para o background." });
    }
    try {
      const storedOverlay = await storeFile(req.file);
      const media = await prisma.slideMedia.update({
        where: { id: req.params.id },
        data: {
          overlaySource: storedOverlay.source,
          overlayType: mediaType(req.file),
        },
      });
      io.emit("SLIDE_ATUALIZADO");
      res.json(media);
    } catch (error) {
      console.error("Erro ao adicionar background à cena:", error);
      res.status(503).json({ error: databaseError(error) });
    }
  },
);

app.delete("/api/slide/:id/overlay", async (req, res) => {
  try {
    const media = await prisma.slideMedia.update({
      where: { id: req.params.id },
      data: { overlaySource: null, overlayType: null },
    });
    io.emit("SLIDE_ATUALIZADO");
    res.json(media);
  } catch (error) {
    console.error("Erro ao remover background da cena:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.post("/api/slide/:id/overlay-from-library", async (req, res) => {
  const source = String(req.body.source || "");
  const relativeSource = source.replace(/^\/+/, "");
  const filePath = path.resolve(publicDirectory, relativeSource);
  if (
    !source.startsWith("/") ||
    relativeSource.includes("..") ||
    !filePath.startsWith(`${publicDirectory}${path.sep}`)
  ) {
    return res.status(400).json({ error: "Mídia da biblioteca inválida." });
  }
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error("Arquivo inválido");
    const media = await prisma.slideMedia.update({
      where: { id: req.params.id },
      data: { overlaySource: source, overlayType: uploadedFileType(source) },
    });
    await rememberAsset(source, "background");
    io.emit("SLIDE_ATUALIZADO");
    res.json(media);
  } catch (error) {
    console.error("Erro ao aplicar background da biblioteca:", error);
    res.status(error.code === "ENOENT" ? 404 : 503).json({
      error:
        error.code === "ENOENT"
          ? "Arquivo não encontrado."
          : databaseError(error),
    });
  }
});

app.put("/api/slide/order", async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length || ids.some((id) => typeof id !== "string")) {
    return res.status(400).json({ error: "Informe a ordem das cenas." });
  }
  try {
    const existing = await prisma.slideMedia.findMany({ select: { id: true } });
    const existingIds = new Set(existing.map((item) => item.id));
    if (
      ids.length !== existing.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existingIds.has(id))
    ) {
      return res
        .status(400)
        .json({ error: "A lista de cenas está desatualizada." });
    }
    await prisma.$transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx.slideMedia.update({
          where: { id },
          data: { position: -(index + 1) },
        });
      }
      for (const [index, id] of ids.entries()) {
        await tx.slideMedia.update({
          where: { id },
          data: { position: index + 1 },
        });
      }
    });
    io.emit("SLIDE_ATUALIZADO");
    res.json({ ids });
  } catch (error) {
    console.error("Erro ao reordenar mídias do slide:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.delete("/api/slide/:id", async (req, res) => {
  try {
    const media = await prisma.slideMedia.delete({
      where: { id: req.params.id },
    });
    await prisma.slideMedia.updateMany({
      where: { position: { gt: media.position } },
      data: { position: { decrement: 1 } },
    });
    io.emit("SLIDE_ATUALIZADO");
    res.status(204).end();
  } catch (error) {
    console.error("Erro ao remover mídia do slide:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

const rankingSelect = {
  id: true,
  numero: true,
  nomeCliente: true,
  totalGasto: true,
  updatedAt: true,
};

app.get("/api/ranking", async (req, res) => {
  try {
    const ranking = await prisma.camarote.findMany({
      orderBy: { totalGasto: "desc" },
      take: 10,
      select: rankingSelect,
    });
    res.json(ranking);
  } catch (error) {
    console.error("Erro ao buscar ranking:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.get("/api/camarotes", async (req, res) => {
  try {
    const camarotes = await prisma.camarote.findMany({
      orderBy: { totalGasto: "desc" },
      select: rankingSelect,
    });
    res.json(camarotes);
  } catch (error) {
    console.error("Erro ao buscar camarotes:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.get("/api/camarote/:id", async (req, res) => {
  try {
    const camarote = await prisma.camarote.findUnique({
      where: { id: req.params.id },
      include: { transacoes: { orderBy: { createdAt: "desc" } } },
    });
    if (!camarote)
      return res.status(404).json({ error: "Cliente nao encontrado." });
    res.json(camarote);
  } catch (error) {
    console.error("Erro ao buscar detalhes:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.patch("/api/camarote/:id", async (req, res) => {
  const numero = String(req.body.numero || "").trim();
  const nomeCliente = String(req.body.nomeCliente || "").trim();
  if (!numero || !nomeCliente) {
    return res
      .status(400)
      .json({ error: "Informe o camarote e o nome do cliente." });
  }
  try {
    const camarote = await prisma.camarote.update({
      where: { id: req.params.id },
      data: { numero, nomeCliente },
    });
    io.emit("RANKING_ATUALIZADO");
    res.json(camarote);
  } catch (error) {
    console.error("Erro ao editar camarote:", error);
    res.status(error.code === "P2002" ? 409 : 503).json({
      error:
        error.code === "P2002"
          ? "Esse numero de camarote ja esta em uso."
          : databaseError(error),
    });
  }
});

app.patch("/api/camarote/:id/total", async (req, res) => {
  const totalGasto = parseValor(req.body.total);
  if (!Number.isFinite(totalGasto) || totalGasto < 0) {
    return res.status(400).json({ error: "Informe um valor total válido." });
  }
  try {
    const camarote = await prisma.camarote.update({
      where: { id: req.params.id },
      data: { totalGasto },
      select: rankingSelect,
    });
    io.emit("RANKING_ATUALIZADO");
    res.json(camarote);
  } catch (error) {
    console.error("Erro ao editar valor total:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.patch("/api/transacao/:id", async (req, res) => {
  const valor = parseValor(req.body.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    return res.status(400).json({ error: "Informe um valor maior que zero." });
  }
  try {
    const transacao = await prisma.$transaction(async (tx) => {
      const atualizada = await tx.transacao.update({
        where: { id: req.params.id },
        data: {
          valor,
          descricao: String(req.body.descricao || "").trim() || null,
        },
      });
      const total = await tx.transacao.aggregate({
        where: { camaroteId: atualizada.camaroteId },
        _sum: { valor: true },
      });
      await tx.camarote.update({
        where: { id: atualizada.camaroteId },
        data: { totalGasto: total._sum.valor || 0 },
      });
      return atualizada;
    });
    io.emit("RANKING_ATUALIZADO");
    res.json(transacao);
  } catch (error) {
    console.error("Erro ao editar transacao:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.post("/api/camarote/:id/venda", async (req, res) => {
  const valor = parseValor(req.body.valor);
  const descricao = String(req.body.descricao || "").trim() || null;
  const numero = String(req.body.numero || "").trim();
  const nomeCliente = String(req.body.nomeCliente || "").trim();
  if (!Number.isFinite(valor) || valor <= 0) {
    return res.status(400).json({ error: "Informe um valor maior que zero." });
  }
  if (!numero || !nomeCliente) {
    return res
      .status(400)
      .json({ error: "Informe o camarote e o nome do cliente." });
  }
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const camarote = await tx.camarote.update({
        where: { id: req.params.id },
        data: { numero, nomeCliente, totalGasto: { increment: valor } },
      });
      const transacao = await tx.transacao.create({
        data: { camaroteId: camarote.id, valor, descricao },
      });
      return { camarote, transacao };
    });
    const ranking = await prisma.camarote.findMany({
      orderBy: { totalGasto: "desc" },
      take: 10,
      select: rankingSelect,
    });
    io.emit("NOVA_VENDA", {
      venda: resultado.camarote,
      transacao: resultado.transacao,
      ranking,
    });
    res.status(201).json({ ...resultado, ranking });
  } catch (error) {
    console.error("Erro ao registrar combo adicional:", error);
    res.status(error.code === "P2002" ? 409 : 503).json({
      error:
        error.code === "P2002"
          ? "Esse numero de camarote ja esta em uso."
          : databaseError(error),
    });
  }
});

app.post("/api/venda", async (req, res) => {
  const { camaroteNumero, nomeCliente, valor, descricao } = req.body;
  const valorNumerico = parseValor(valor);
  const numero = String(camaroteNumero || "").trim();
  const cliente = String(nomeCliente || "").trim();

  if (
    !numero ||
    !cliente ||
    !Number.isFinite(valorNumerico) ||
    valorNumerico <= 0
  ) {
    return res
      .status(400)
      .json({ error: "Informe camarote, cliente e um valor maior que zero." });
  }

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const camarote = await tx.camarote.upsert({
        where: { numero },
        create: { numero, nomeCliente: cliente, totalGasto: valorNumerico },
        update: {
          nomeCliente: cliente,
          totalGasto: { increment: valorNumerico },
        },
      });

      const transacao = await tx.transacao.create({
        data: {
          camaroteId: camarote.id,
          valor: valorNumerico,
          descricao: String(descricao || "").trim() || null,
        },
      });

      return { camarote, transacao };
    });

    const ranking = await prisma.camarote.findMany({
      orderBy: { totalGasto: "desc" },
      take: 10,
      select: rankingSelect,
    });

    io.emit("NOVA_VENDA", {
      venda: resultado.camarote,
      transacao: resultado.transacao,
      ranking,
    });
    res.status(201).json({ ...resultado, ranking });
  } catch (error) {
    console.error("Erro ao registrar venda:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.post("/api/reset", async (req, res) => {
  try {
    await prisma.$transaction([
      prisma.transacao.deleteMany(),
      prisma.camarote.deleteMany(),
    ]);
    io.emit("RANKING_RESET");
    res.json({ message: "Ranking resetado com sucesso." });
  } catch (error) {
    console.error("Erro ao resetar ranking:", error);
    res.status(503).json({ error: databaseError(error) });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use((error, req, res, next) => {
  console.error("Erro nao tratado na API:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({
    error: "Erro interno do servidor ao processar a operação.",
  });
});

io.on("connection", (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  socket.on("disconnect", () =>
    console.log(`Cliente desconectado: ${socket.id}`),
  );
});

server.listen(port, () => {
  console.log(`Servidor do Telao rodando em http://localhost:${port}`);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
