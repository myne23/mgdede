# Megadede

Plugin de [Kino](https://kinotvapp.github.io/kino-plugins/) con películas, series y animes en español de Megadede (megadede.mobi). Es el port del plugin de CloudStream `MegadedeProvider`.

En el Inicio aparecen tres filas: **Películas**, **Series** y **Animes** (cada una con "Ver más" paginado). También hay búsqueda, y las series y animes muestran temporadas y capítulos, con la imagen y la sinopsis de cada capítulo cuando la serie es corta.

No pide cuenta ni ajustes.

## Cómo reproduce

Cada página de Megadede trae servidores directos (`changeServer(...)`) y una página `/vidurl/` (Embed69) que esconde los links reales detrás de una prueba de trabajo (SHA-256) y cifrado AES-256-CBC. El plugin resuelve las dos cosas por su cuenta:

- Elige el mejor idioma disponible: **LAT**, después **ESP** y después **SUB**. Cada servidor se muestra con su idioma ("Vidhide lat", "Voe sub"...).
- Prueba primero los resolvers directos por HTTP: StreamWish, Vidhide (lista `hls4`/`hls2`/`hls3`), Voe (incluido su desafío ALTCHA), Dailymotion, OK.ru, Rumble, Odysee, Filemoon/Byse y sp2p.
- Si un servidor no se deja leer por HTTP, usa el navegador oculto de Kino como respaldo (necesita Kino 0.9.50 o más nuevo).
- Los demás servidores quedan en el menú "Servidor" y solo se resuelven si los eliges.

Los servidores de cada página se guardan 15 minutos, así que cambiar de servidor no repite la prueba de trabajo de Embed69.

## Archivos

- `kino-plugin.json`: el manifiesto (hosts, permisos, versión).
- `plugin.js`: el código del plugin.
- `test/plugin.test.mjs`: pruebas sin conexión (`node --test test/plugin.test.mjs`).
- `sdk/`, `contract.json`, `kino.d.ts`: el kit de Kino (Apache 2.0, ver LICENSE y NOTICE). Validar: `node sdk/validate.mjs .`

## Instalar

1. Crea un repositorio público en GitHub (por ejemplo `megadede`) y sube todos estos archivos.
2. Agrega el topic `kino-plugin` al repositorio (sin él, Kino no lo encuentra en la búsqueda de la comunidad).
3. En Kino: Ajustes > Plugins, escribe `usuario/repositorio` y acepta los permisos.
