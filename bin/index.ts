#! /usr/bin/env node
import axios, { AxiosRequestConfig } from "axios";
import { program, Option } from "commander";
import * as fs from "fs";
import { fdir } from "fdir";
import * as si from "systeminformation";
import * as readline from "readline";
import * as path from "path";
import FormData from "form-data";
import { ExifDateTime, exiftool, Tags } from "exiftool-vendored";
import * as cliProgress from "cli-progress";
import { stat } from "fs/promises";
// GLOBAL
import * as mime from "mime-types";
import chalk from "chalk";
import pjson from "../package.json";
import pLimit from "p-limit";

const log = console.log;
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
let errorAssets: any[] = [];

const SUPPORTED_MIME_TYPES = [
  // IMAGES
  "image/heif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/jpg",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/dng",
  "image/x-adobe-dng",
  "image/webp",
  "image/tiff",
  "image/nef",
  "image/x-nikon-nef",

  // VIDEO
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/3gpp",
];

program
  .name("Immich CLI")
  .description("Immich command line interface based on nodejs")
  .version(pjson.version);

program
  .command("upload")
  .description("Upload assets to an Immich instance")
  .addOption(
    new Option("-k, --key <value>", "API Key").env("IMMICH_API_KEY")
  )
  .addOption(
    new Option(
      "-s, --server <value>",
      "Immich server address (http://<your-ip>:2283/api or https://<your-domain>/api)"
    ).env("IMMICH_SERVER_ADDRESS")
  )
  .addOption(
    new Option("-r, --recursive", "Recursive").env(
      "IMMICH_RECURSIVE"
    ).default(false)
  )
  .addOption(
    new Option("-y, --yes", "Assume yes on all interactive prompts").env(
      "IMMICH_ASSUME_YES"
    )
  )
  .addOption(
    new Option("-da, --delete", "Delete local assets after upload").env(
      "IMMICH_DELETE_ASSETS"
    )
  )
  .addOption(
    new Option(
      "-t, --threads",
      "Amount of concurrent upload threads (default=5)"
    ).env("IMMICH_UPLOAD_THREADS")
  )
  .addOption(
    new Option(
      "-al, --album [album]",
      "Create albums for assets based on the parent folder or a given name"
    ).env("IMMICH_CREATE_ALBUMS")
  )
  .addOption(
    new Option(
      "-id, --device-uuid <value>",
      "Set a device UUID"
    ).env("IMMICH_DEVICE_UUID")
  )
  .argument(
    '<paths...>'
  )
  .action((str, options) => {
    upload(str, options);
  });

program.parse(process.argv);

async function upload(paths: String,{
  key,
  server,
  recursive,
  yes: assumeYes,
  delete: deleteAssets,
  uploadThreads,
  album: createAlbums,
  deviceUuid: deviceUuid
}: any) {
  const endpoint = server;
  const deviceId = deviceUuid || (await si.uuid()).os || "CLI";
  const localAssets: any[] = [];

  // Ping server
  log("[1] Pinging server...");
  await pingServer(endpoint);

  // Login
  log("[2] Logging in...");
  const user = await validateConnection(endpoint, key);
  log(chalk.yellow(`Connected to Immich with user ${user.email}`));

  // Index provided directory
  log("[4] Indexing files...");
  let crawler = new fdir().withFullPaths();

  if (!recursive)
  {
    // Don't go into subfolders
    crawler = crawler.withMaxDepth(0);
  }

  let files: any[] = [];

  for (const newPath of paths) {    
    // Will throw error if path does not exist
    await fs.promises.access(newPath);
 
    if (await isDirectory(newPath)) 
    {
      // Is a directory so use the crawler to crawl it
      const api = crawler.crawl(newPath);
      files=files.concat((await api.withPromise()));

    } else {
      files.push(path.resolve(newPath));
    }

  }

  const uniqueFiles = new Set(files);

  for(const filePath of uniqueFiles) {
    const mimeType = mime.lookup(filePath) as string;
    if (SUPPORTED_MIME_TYPES.includes(mimeType)) {
      const fileStat = fs.statSync(filePath);
      localAssets.push({
        id: `${path.basename(filePath)}-${fileStat.size}`.replace(/\s+/g, ""),
        filePath,
      });
    }
  }
  log(chalk.green("Indexing file: OK"));
  log(
    chalk.yellow(`Found ${localAssets.length} assets in specified directory`)
  );

  // Find assets that has not been backup
  log("[5] Gathering device's asset info from server...");

  const backupAsset = await getAssetInfoFromServer(
    endpoint,
    key,
    deviceId
  );

  const newAssets = localAssets.filter(a => !backupAsset.includes(a.id));
  if (localAssets.length == 0 || (newAssets.length == 0 && !createAlbums)) {
    log(chalk.green("All assets have been backed up to the server"));
    process.exit(0);
  } else {
    log(
      chalk.green(
        `A total of ${newAssets.length} assets will be uploaded to the server`
      )
    );
  }

  if (createAlbums) {
    log(chalk.green(
      `A total of ${localAssets.length} assets will be added to album(s).\n` +
      "NOTE: some assets may already be associated with the album, this will not create duplicates."
    ));
  }

  // Ask user
  try {
    //There is a promise API for readline, but it's currently experimental
    //https://nodejs.org/api/readline.html#promises-api
    const answer = assumeYes
      ? "y"
      : await new Promise((resolve) => {
        rl.question("Do you want to start upload now? (y/n) ", resolve);
      });
    const deleteLocalAsset = deleteAssets ? "y" : "n";

    if (answer == "n") {
      log(chalk.yellow("Abort Upload Process"));
      process.exit(1);
    }

    if (answer == "y") {
      log(chalk.green("Start uploading..."));
      const progressBar = new cliProgress.SingleBar(
        {
          format:
            "Upload Progress | {bar} | {percentage}% || {value}/{total} || Current file [{filepath}]",
        },
        cliProgress.Presets.shades_classic
      );
      progressBar.start(localAssets.length, 0, { filepath: "" });

      const assetDirectoryMap: Map<string, string[]> = new Map();

      const uploadQueue = [];

      const limit = pLimit(uploadThreads ?? 5);

      for (const asset of localAssets) {
        const album = asset.filePath.split(path.sep).slice(-2)[0];
        if (!assetDirectoryMap.has(album)) {
          assetDirectoryMap.set(album, []);
        }

        if (!backupAsset.includes(asset.id)) {
          // New file, lets upload it!
          uploadQueue.push(
            limit(async () => {
              try {
                const res = await startUpload(
                  endpoint,
                  key,
                  asset,
                  deviceId,
                );
                progressBar.increment(1, { filepath: asset.filePath });
                if (res && (res.status == 201 || res.status == 200)) {
                  if (deleteLocalAsset == "y") {
                    fs.unlink(asset.filePath, (err) => {
                      if (err) {
                        log(err);
                        return;
                      }
                    });
                  }
                  backupAsset.push(asset.id);
                  assetDirectoryMap.get(album)!.push(res!.data.id);
                }
              } catch (err) {
                log(chalk.red(err.message));
              }
            })
          );
        } else if (createAlbums) {
          // Existing file. No need to upload it BUT lets still add to Album.
          uploadQueue.push(
            limit(async () => {
              try {
                // Fetch existing asset from server
                const res = await axios.post(
                  `${endpoint}/asset/check`,
                  {
                    deviceAssetId: asset.id,
                    deviceId,
                  },
                  {
                    headers: { "x-api-key": key },
                  }
                );
                assetDirectoryMap.get(album)!.push(res!.data.id);
              } catch (err) {
                log(chalk.red(err.message));
              }
            })
          );
        }
      }

      const uploads = await Promise.all(uploadQueue);

      progressBar.stop();

      if (createAlbums) {
        log(chalk.green("Creating albums..."));

        const serverAlbums = await getAlbumsFromServer(endpoint, key);

        if (typeof createAlbums === "boolean") {
          progressBar.start(assetDirectoryMap.size, 0);

          for (const localAlbum of assetDirectoryMap.keys()) {
            const serverAlbumIndex = serverAlbums.findIndex(
              (album: any) => album.albumName === localAlbum
            );
            let albumId: string;
            if (serverAlbumIndex > -1) {
              albumId = serverAlbums[serverAlbumIndex].id;
            } else {
              albumId = await createAlbum(endpoint, key, localAlbum);
            }

            if (albumId) {
              await addAssetsToAlbum(
                endpoint,
                key,
                albumId,
                assetDirectoryMap.get(localAlbum)!
              );
            }

            progressBar.increment();
          }

          progressBar.stop();
        } else {
          const serverAlbumIndex = serverAlbums.findIndex(
            (album: any) => album.albumName === createAlbums
          );
          let albumId: string;

          if (serverAlbumIndex > -1) {
            albumId = serverAlbums[serverAlbumIndex].id;
          } else {
            albumId = await createAlbum(endpoint, key, createAlbums);
          }

          await addAssetsToAlbum(
            endpoint,
            key,
            albumId,
            Array.from(assetDirectoryMap.values()).flat()
          );
        }
      }

      log(
        chalk.yellow(`Failed to upload ${errorAssets.length} files `),
        errorAssets
      );

      if (errorAssets.length > 0) {
        process.exit(1);
      }

      process.exit(0);
    }
  } catch (e) {
    log(chalk.red("Error reading input from user "), e);
    process.exit(1);
  }
}

async function startUpload(
  endpoint: string,
  key: string,
  asset: any,
  deviceId: string
) {
  try {
    const assetType = getAssetType(asset.filePath);
    const fileStat = await stat(asset.filePath);

    const exifData = await exiftool.read(asset.filePath).catch((e) => {
      log(chalk.red(`The exifData parsing failed due to: ${e} on file ${asset.filePath}`));
      return null;
    });

    const exifToDate = (exifDate: string | ExifDateTime | undefined) => {
      if (!exifDate) return null;

      if (typeof exifDate === 'string') {
        return new Date(exifDate).toISOString();
      }

      return exifDate.toDate().toISOString();
    };

    const fileCreatedAt = exifToDate(exifData?.DateTimeOriginal ?? exifData?.CreateDate ?? asset.fileCreatedAt);

    const data = new FormData();
    data.append("deviceAssetId", asset.id);
    data.append("deviceId", deviceId);
    data.append("assetType", assetType);
    data.append("fileCreatedAt", fileCreatedAt);
    data.append("fileModifiedAt", fileStat.mtime.toISOString());
    data.append("isFavorite", JSON.stringify(false));
    data.append("fileExtension", path.extname(asset.filePath));
    data.append("duration", "0:00:00.000000");

    data.append("assetData", fs.createReadStream(asset.filePath));

    const config: AxiosRequestConfig<any> = {
      method: "post",
      maxRedirects: 0,
      url: `${endpoint}/asset/upload`,
      headers: {
        "x-api-key": key,
        ...data.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      data: data,
    };

    const res = await axios(config);
    return res;
  } catch (e) {
    errorAssets.push({
      file: asset.filePath,
      reason: e,
      response: e.response?.data,
    });
    return null;
  }
}

async function getAlbumsFromServer(endpoint: string, key: string) {
  try {
    const res = await axios.get(`${endpoint}/album`, {
      headers: { "x-api-key": key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red("Error getting albums"), e);
    process.exit(1);
  }
}

async function createAlbum(
  endpoint: string,
  key: string,
  albumName: string
) {
  try {
    const res = await axios.post(
      `${endpoint}/album`,
      { albumName },
      {
        headers: { "x-api-key": key },
      }
    );
    return res.data.id;
  } catch (e) {
    log(chalk.red(`Error creating album '${albumName}'`), e);
  }
}

async function addAssetsToAlbum(
  endpoint: string,
  key: string,
  albumId: string,
  assetIds: string[]
) {
  try {
    await axios.put(
      `${endpoint}/album/${albumId}/assets`,
      { assetIds: [...new Set(assetIds)] },
      {
        headers: { "x-api-key": key },
      }
    );
  } catch (e) {
    log(chalk.red("Error adding asset to album"), e);
  }
}

async function getAssetInfoFromServer(
  endpoint: string,
  key: string,
  deviceId: string
) {
  try {
    const res = await axios.get(`${endpoint}/asset/${deviceId}`, {
      headers: { "x-api-key": key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red("Error getting device's uploaded assets"));
    process.exit(1);
  }
}

async function pingServer(endpoint: string) {
  try {
    const res = await axios.get(`${endpoint}/server-info/ping`);
    if (res.data["res"] == "pong") {
      log(chalk.green("Server status: OK"));
    }
  } catch (e) {
    log(
      chalk.red("Error connecting to server - check server address and port: " + e)
    );
    process.exit(1);
  }
}

async function validateConnection(endpoint: string, key: string) {
  try {
    const res = await axios.get(`${endpoint}/user/me`, {
      headers: { "x-api-key": key },
    })

    if (res.status == 200) {
      log(chalk.green("Login status: OK"));
      return res.data;
    }
  } catch (e) {
    log(chalk.red("Error logging in - check api key"));
    process.exit(1);
  }
}

function getAssetType(filePath: string) {
  const mimeType = mime.lookup(filePath) as string;

  return mimeType.split("/")[0].toUpperCase();
}

async function isDirectory(path: string) {  
  const stats = await fs.promises.lstat(path)

  return stats.isDirectory()
}