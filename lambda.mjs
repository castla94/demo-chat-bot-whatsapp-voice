import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";

const TABLE_NAME = "whatsapp_prompt";
const PK_NAME = "email";
const PK_VALUE = "inversionesydalvarez@gmail.com";
const PK_VALUE2 = "jhonfa144@gmail.com";
const PK_VALUES = [PK_VALUE, PK_VALUE2];
const MAX_PAGES = 500;
const MAX_MARKDOWN_BYTES = 350000;
const dynamodb = new DynamoDBClient({});

function clean(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function response(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(data)
  };
}

const TREINTA_STORE_ID = "28bbedc4-78d9-5165-bad0-ab3daecf1b6d";
const TREINTA_STORE_SLUG = "luegopagoapk";
const TREINTA_PRODUCTS_URL = "https://tienda.treinta.co/api/storefront/products";

async function requestTreinta(url, context) {
  const remaining = context?.getRemainingTimeInMillis?.() ?? Infinity;
  const timeout = Math.min(30000, Math.floor(remaining - 5000));
  if (timeout < 1000) {
    throw new Error("Tiempo insuficiente para consultar Treinta: queda menos de 1 segundo disponible después de reservar 5 segundos para finalizar");
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Referer: `https://tienda.treinta.co/${TREINTA_STORE_SLUG}`
    },
    signal: AbortSignal.timeout(timeout)
  });

  if (!res.ok) {
    throw new Error(`Treinta HTTP ${res.status}`);
  }

  return res.json();
}

export async function getTreintaProducts(context) {
  const products = [];
  const errors = [];
  const seen = new Set();
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(TREINTA_PRODUCTS_URL);
    url.search = new URLSearchParams({
      storeId: TREINTA_STORE_ID,
      page: String(page),
      pageSize: "12",
      storeSlug: TREINTA_STORE_SLUG,
      withPriceBands: "1"
    }).toString();

    const listing = await requestTreinta(url, context);
    if (!Array.isArray(listing.products) ||
        !Number.isInteger(listing.total) || listing.total < 0 ||
        listing.products.some(product => !product?.id)) {
      throw new Error("Listado de Treinta inválido");
    }
    total = listing.total;
    const batch = listing.products.filter(product => {
      if (seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    });

    const results = await Promise.allSettled(batch.map(async product => {
      const detailUrl = new URL(
        `${TREINTA_PRODUCTS_URL}/${encodeURIComponent(product.id)}`
      );
      detailUrl.searchParams.set("storeId", TREINTA_STORE_ID);
      const detail = await requestTreinta(detailUrl, context);
      if (!detail.product || detail.product.id !== product.id) {
        throw new Error("Detalle de Treinta inválido");
      }
      return { ...product, ...detail.product };
    }));

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        products.push(result.value);
      } else {
        errors.push({
          id: batch[index].id,
          message: result.reason?.message || String(result.reason)
        });
      }
    });

    if (seen.size >= total) {
      return { products, total, errors, fetchedAt: new Date().toISOString() };
    }
    if (!batch.length) {
      throw new Error("La paginación de Treinta terminó antes de completar el catálogo");
    }
  }

  throw new Error("Se alcanzó el límite de páginas de Treinta");
}

// Generar el catálogo usando los precios de cada variante de Treinta.
export function generateMarkdown(products) {
  const groups = new Map();
  for (const product of products) {
    const category = clean(product.category) || "SIN CATEGORÍA";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(product);
  }

  const lines = [
    "# CATÁLOGO DE PRODUCTOS - LUEGOPAGO",
    "",
    `Actualizado: ${new Date().toISOString()}`,
    `Total de referencias: ${products.length}`,
    "",
    "- Precios expresados en USD, obtenidos de Treinta.",
    "- Cada método de pago tiene su propio precio; respetar la tarifa indicada.",
    "- El stock es único por producto y compartido entre todos los métodos de pago.",
    "- No inventar productos, precios ni características.",
    ""
  ];

  function addPrice(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      lines.push(`- Precio: $${value.toFixed(2)} USD`);
    }
  }



  for (const category of [...groups.keys()].sort((a, b) => a.localeCompare(b, "es"))) {
    lines.push(`## ${category}`, "");
    const items = groups.get(category).sort((a, b) =>
      clean(a.name).localeCompare(clean(b.name), "es", { numeric: true })
    );
    for (const product of items) {
      lines.push(`### ${clean(product.name)}`);
      if (clean(product.description)) lines.push(`- Descripción: ${clean(product.description)}`);
      if (typeof product.available === "boolean") {
        lines.push(`- Disponible: ${product.available ? "Sí" : "No"}`);
      }
      if (product.stock != null) lines.push(`- Stock total: ${clean(product.stock)}`);

      const variants = Array.isArray(product.variants) ? product.variants : [];
      if (variants.length) {
        for (const variant of variants) {
          lines.push("", `#### ${clean(variant.name) || "Variante"}`);
          addPrice(variant.price);
          for (const attribute of Array.isArray(variant.attributes) ? variant.attributes : []) {
            lines.push(`- ${clean(attribute.name)}: ${clean(attribute.value)}`);
          }
        }
      } else if (!product.hasVariants) {
        addPrice(product.price);
      } else {
        throw new Error(`Producto con variantes sin detalle: ${product.id}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}

async function getPromptItem(pk) {
  const data = await dynamodb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        [PK_NAME]: { S: pk }
      },
      ConsistentRead: true
    })
  );

  if (!data.Item) {
    throw new Error(
      `No existe ${pk} en ${TABLE_NAME}`
    );
  }

  return data.Item;
}

// ==========================================
// DYNAMODB UPDATE SOLO PRODUCTS
// ==========================================

async function updateProducts(markdown, pk) {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        [PK_NAME]: { S: pk }
      },
      UpdateExpression:
        "SET #products = :value",
      ConditionExpression:
        "attribute_exists(#pk)",
      ExpressionAttributeNames: {
        "#products": "products",
        "#pk": PK_NAME
      },
      ExpressionAttributeValues: {
        ":value": { S: markdown }
      },
      ReturnValues: "NONE"
    })
  );
}

export const handler = async (event = {}, context) => {
  try {
    const input = typeof event.body === "string"
      ? JSON.parse(event.body || "{}")
      : event.body && typeof event.body === "object" ? event.body : event;
    const dryRun = input?.dryRun === true;
    const catalog = await getTreintaProducts(context);

    // No reemplazar el catálogo guardado con una descarga incompleta.
    if (catalog.errors.length) {
      return response(502, {
        success: false,
        message: "No fue posible obtener todos los detalles de Treinta",
        total_products: catalog.total,
        fetched_products: catalog.products.length,
        errors: catalog.errors
      });
    }
    if (!catalog.products.length) throw new Error("Catálogo de Treinta vacío");

    const markdown = generateMarkdown(catalog.products);
    const bytes = Buffer.byteLength(markdown, "utf8");
    if (bytes > MAX_MARKDOWN_BYTES) {
      throw new Error(`Markdown demasiado grande: ${bytes} bytes`);
    }
    const summary = {
      total_products: catalog.products.length,
      markdown_bytes: bytes
    };
    if (dryRun) {
      return response(200, {
        success: true,
        dryRun: true,
        ...summary,
        preview: markdown
      });
    }

    await Promise.all(PK_VALUES.map(pk => getPromptItem(pk)));
    console.log("markdown: ",markdown)
    const results = await Promise.allSettled(
      PK_VALUES.map(pk => updateProducts(markdown, pk))
    );
    const updated = PK_VALUES.filter((pk, index) => results[index].status === "fulfilled");
    const errors = results.flatMap((result, index) => result.status === "rejected"
      ? [{ pk: PK_VALUES[index], message: result.reason?.message || String(result.reason) }]
      : []);
    if (errors.length) {
      return response(500, {
        success: false,
        table: TABLE_NAME,
        updated_field: "products",
        updated_pks: updated,
        errors,
        message: "No fue posible actualizar todos los registros"
      });
    }
    return response(200, {
      success: true,
      table: TABLE_NAME,
      pk: PK_VALUE,
      pks: PK_VALUES,
      updated_field: "products",
      ...summary,
      message: "Catálogo de Treinta actualizado correctamente"
    });
  } catch (error) {
    console.error(error);
    return response(500, {
      success: false,
      table: TABLE_NAME,
      pk: PK_VALUE,
      pks: PK_VALUES,
      updated_field: "products",
      message: "No fue posible completar la sincronización",
      error: error.message
    });
  }
};
