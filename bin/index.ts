#! /usr/bin/env node
import axios, { AxiosRequestConfig } from "axios";
import { program, Option } from "commander";
import * as fs from "fs";
import { fdir } from "fdir";
import * as si from "systeminformation";
import * as readline from "readline";
import * as path from "path";
import FormData from "form-data";
import * as cliProgress from "cli-progress";
import { stat } from "fs/promises";
import * as exifr from "exifr";
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

const SUPPORTED_MIME = [
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
  .name("Immich CLI Utilities")
  .description("Immich CLI Utilities toolset")
  .version(pjson.version);

program
  .command("upload")
  .description("Upload images and videos in a directory to Immich's server")
  .addOption(
    new Option("-da, --delete", "Delete local assets after upload").env(
      "IMMICH_DELETE_ASSETS"
    )
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
  .action(upload);

  program
  .command("download")
  .description("Download images and videos into a directory from a specific album on Immich's server")
  .addOption(
    new Option("-da, --delete", "Delete local assets if not found in album").env(
      "IMMICH_DELETE_ASSETS"
    )
  )
  .addOption(
    new Option(
      "-al, --album <album>",
      "Album name or id to download"
    ).env("IMMICH_ALBUM")
  )
  .action(download);

  //Shared options
  program.commands.forEach((cmd: any) => {
    cmd.addOption(
      new Option("-k, --key <value>", "API Key").env("IMMICH_API_KEY")
    )
    .addOption(
      new Option(
        "-s, --server <value>",
        "Server address (http://<your-ip>:2283/api or https://<your-domain>/api)"
      ).env("IMMICH_SERVER_ADDRESS")
    )
    .addOption(
      new Option("-d, --directory <value>", "Target Directory").env(
        "IMMICH_TARGET_DIRECTORY"
      )
    )
    .addOption(
      new Option("-y, --yes", "Assume yes on all interactive prompts").env(
        "IMMICH_ASSUME_YES"
      )
    )
    .addOption(
      new Option(
        "-t, --threads",
        "Amount of concurrent upload threads (default=5)"
      ).env("IMMICH_UPLOAD_THREADS")
    )
  });

program.parse(process.argv);

async function upload({
  key,
  server,
  directory,
  yes: assumeYes,
  delete: deleteAssets,
  uploadThreads,
  album: createAlbums,
  deviceUuid: deviceUuid
}: any) {
  const endpoint = server;
  const deviceId = deviceUuid || (await si.uuid()).os || "CLI";
  const osInfo = (await si.osInfo()).distro;
  const localAssets: any[] = [];

  // Ping server
  log("[1] Pinging server...");
  await pingServer(endpoint);

  // Login
  log("[2] Logging in...");
  const user = await validateConnection(endpoint, key);
  log(chalk.yellow(`Connected to Immich with user ${user.email}`));

  // Check if directory exist
  log("[3] Checking directory...");
  if (fs.existsSync(directory)) {
    log(chalk.green("Directory status: OK"));
  } else {
    log(chalk.red("Error navigating to directory - check directory path"));
    process.exit(1);
  }

  // Index provided directory
  log("[4] Indexing files...");
  const api = new fdir().withFullPaths().crawl(directory);

  const files = (await api.withPromise()) as any[];

  for (const filePath of files) {
    const mimeType = mime.lookup(filePath) as string;
    if (SUPPORTED_MIME.includes(mimeType)) {
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

async function download({
  key,
  server,
  directory,
  yes: assumeYes,
  delete: deleteAssets,
  downloadThreads,
  album
}: any) {
  const endpoint = server;
  const localAssets: any[] = [];
  const downloadAssets: any[] = [];
  const removeAssets: any[] = [];

  // Ping server
  log("[1] Pinging server...");
  await pingServer(endpoint);

  // Login
  log("[2] Logging in...");
  const user = await validateConnection(endpoint, key);
  log(chalk.yellow(`Connected to Immich with user ${user.email}`));

  // Check if directory exist
  log("[3] Checking directory...");
  if (fs.existsSync(directory)) {
    log(chalk.green("Directory status: OK"));
  } else {
    log(chalk.red("Error navigating to directory - check directory path"));
    process.exit(1);
  }

  log("[4] Fetching albums...");
  const serverAlbums = await getAlbumsFromServer(endpoint, key);
  const sourceAlbum = serverAlbums.find((a: any) => a.id == album || a.albumName == album);
  if(!sourceAlbum) {
    log(chalk.red(`Unable to find album on server: ${album}`));
    process.exit(1);
  }

  log(`[5] Fetching remote album assets: ${sourceAlbum.albumName}`);
  const albumInfo = await getAlbumInfo(endpoint, key, sourceAlbum.id);
  if(!albumInfo) {
    log(chalk.red("Unable to fetch remote album info"));
    process.exit(1);
  }

  const remoteAssets = albumInfo.assets;
  log(chalk.yellow(`Found ${remoteAssets.length} remote assets`));

  // Index provided directory
  log("[6] Indexing local files...");
  const api = new fdir().withFullPaths().crawl(directory);
  const files = (await api.withPromise()) as any[];

  for (const filePath of files) {
    const mimeType = mime.lookup(filePath) as string;
    if (SUPPORTED_MIME.includes(mimeType)) {
      localAssets.push({
        id: path.parse(filePath).name,
        filePath,
      });
    }
  }
  log(chalk.green("Indexing files: OK"));
  log(
    chalk.yellow(`Found ${localAssets.length} local assets`)
  );

  for (const remoteAsset of remoteAssets) {
    if(!localAssets.find((localAsset: any) => localAsset.id == remoteAsset.id)) {
      downloadAssets.push(remoteAsset);
    }
  }

  for (const localAsset of localAssets) {
    if(!remoteAssets.find((remoteAsset: any) => localAsset.id == remoteAsset.id)) {
      removeAssets.push(localAsset);
    }
  }

  log(chalk.green(`Assets to download: ${downloadAssets.length}`));

  if(deleteAssets) {
    log(chalk.green(`Assets to remove: ${removeAssets.length}`));
  }

  if(downloadAssets.length + removeAssets.length == 0) {
    log(chalk.green("Finished! - No changes found"));
    process.exit(0);
  }

  const answer = assumeYes
  ? "y"
  : await new Promise((resolve) => {
    rl.question("Do you want to start processing now? (y/n) ", resolve);
  });

  if (answer != "y") {
    log(chalk.yellow("Abort Download Process"));
    process.exit(1);
  }

  log("[7] Proccessing...");

  if(downloadAssets.length > 0) {

    const downloadQueue = [];
    const limit = pLimit(downloadThreads ?? 5);
    const progressBar = new cliProgress.SingleBar(
      {
        format:
          "Download Progress | {bar} | {percentage}% || {value}/{total} || Current file [{filepath}]",
      },
      cliProgress.Presets.shades_classic
    );
    progressBar.start(downloadAssets.length, 0, { filepath: "" });

    for (const asset of downloadAssets) {
      downloadQueue.push(
        limit(async () => {
          await downloadAsset(endpoint, key, asset.id, path.join(directory, asset.id + path.extname(asset.originalPath)));
          progressBar.increment(1, { filepath: asset.id });
        })
      );
    }

    await Promise.all(downloadQueue);
    progressBar.stop();
    log(chalk.green(`${downloadAssets.length} asset(s) downloaded`));
  }

  if(deleteAssets && removeAssets.length > 0) {
    for (const asset of removeAssets) {
      fs.unlink(asset.filePath, (err) => {
        if (err) {
          log(err);
          return;
        }
      });
    }
    log(chalk.green(`${removeAssets.length} asset(s) removed`));
  }

  log(chalk.green("Finished!"));
  process.exit(0);
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

    let exifData = null;
    if (assetType != "VIDEO") {
      try {
        exifData = await exifr.parse(asset.filePath, {
          tiff: true,
          ifd0: true as any,
          ifd1: true,
          exif: true,
          gps: true,
          interop: true,
          xmp: true,
          icc: true,
          iptc: true,
          jfif: true,
          ihdr: true,
        });
      } catch (e) { }
    }

    const createdAt =
      exifData && exifData.DateTimeOriginal != null
        ? new Date(exifData.DateTimeOriginal).toISOString()
        : fileStat.mtime.toISOString();

    const data = new FormData();
    data.append("deviceAssetId", asset.id);
    data.append("deviceId", deviceId);
    data.append("assetType", assetType);
    data.append("fileCreatedAt", createdAt);
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

async function getAlbumInfo(endpoint: string, key: string, albumId: string) {
  try {
    const res = await axios.get(`${endpoint}/album/${albumId}`, {
      headers: { "x-api-key": key },
    });
    return res.data;
  } catch (e) {
    log(chalk.red("Error getting album info"), e);
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

async function downloadAsset(
  endpoint: string,
  key: string,
  assetId: string,
  path: string
) {
  try {
    const writer = fs.createWriteStream(path)

    const res = await axios.get(
      `${endpoint}/asset/download/${assetId}`,
      {
        headers: { "x-api-key": key },
        responseType: 'stream'
      }
    );
    res.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve)
      writer.on('error', reject)
    });

  } catch (e) {
    log(chalk.red(`Error downloading asset: '${assetId}'`), e);
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
      chalk.red("Error connecting to server - check server address and port")
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

// node bin/index.js upload --email testuser@email.com --password password --server http://10.1.15.216:2283/api -d /Users/alex/Documents/immich-cli-upload-test-location
// node bin/index.js upload --help
