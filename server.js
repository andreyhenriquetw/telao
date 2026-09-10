require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
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
app.use(express.static(path.join(__dirname, "public")));

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
