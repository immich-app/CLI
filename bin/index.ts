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
  "iamge/x-nikon-nef",

  // VIDEO
  "video/mp4",
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
    new Option("-e, --email <value>", "User's Email").env("IMMICH_USER_EMAIL")
  )
  .addOption(
    new Option("-pw, --password <value>", "User's Password").env(
      "IMMICH_USER_PASSWORD"
    )
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
      "-gt, --google-takeout",
      "Load additional metadata from Google Takeout export json files"
    ).env("IMMICH_GOOGLE_TAKEOUT")
  )
  .addOption(
    new Option(
      "-al, --album [album]",
      "Create albums for assets based on the parent folder or a given name. Only adds new assets to the album(s)"
    ).env("IMMICH_CREATE_ALBUMS")
  )
  .action(upload);

program.parse(process.argv);

async function upload({
  email,
  password,
  server,
  directory,
  yes: assumeYes,
  delete: deleteAssets,
  uploadThreads,
  album: createAlbums,
  googleTakeout: fromGoogleTakeout,
}: any) {
  const endpoint = server;
  const deviceId = (await si.uuid()).os || "CLI";
  const osInfo = (await si.osInfo()).distro;
  const localAssets: any[] = [];
  const newAssets: any[] = [];
  const existingAssets: any[] = [];

  // Ping server
  log("[1] Pinging server...");
  await pingServer(endpoint);

  // Login
  log("[2] Logging in...");
  const { accessToken, userId, userEmail } = await login(
    endpoint,
    email,
    password
  );
  log(chalk.yellow(`You are logged in as ${userEmail}`));

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
    accessToken,
    deviceId
  );

  localAssets.forEach((localAsset) => {
    if (!backupAsset.includes(localAsset.id)) {
      newAssets.push(localAsset);
    }
  });

  if (newAssets.length == 0) {
    log(chalk.green("All assets have been backup to the server"));
    process.exit(0);
  } else {
    log(
      chalk.green(
        `A total of ${newAssets.length} assets will be uploaded to the server`
      )
    );
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
                  accessToken,
                  asset,
                  deviceId,
                  fromGoogleTakeout
                );
                progressBar.increment(1, { filepath: asset.filePath });
                if (res && res.status == 201) {
                  if (deleteLocalAsset == "y") {
                    fs.unlink(asset.filePath, (err) => {
                      if (err) {
                        log(err);
                        return;
                      }
                    });
                  }
                  assetDirectoryMap.get(album)!.push(res!.data.id);
                }
              } catch (err) {
                log(chalk.red(err.message));
              }
            })
          );
        } else {
          // Existing file. No need to upload it BUT lets still add to Album.
          if (createAlbums) {
            uploadQueue.push(
              limit(async () => {
                try {
                  const res = await axios.post(
                    `${endpoint}/asset/check`,
                    {
                      deviceAssetId: asset.id,
                      deviceId,
                    },
                    {
                      headers: { Authorization: `Bearer ${accessToken} ` },
                    }
                  );
                  assetDirectoryMap.get(album)!.push(res!.data.id);
                } catch (err) {
                  log(chalk.red(err.message));
                }
              })
            )
          }
        }
      }

      const uploads = await Promise.all(uploadQueue);

      progressBar.stop();

      if (createAlbums) {
        log(chalk.green("Creating albums..."));

        const serverAlbums = await getAlbumsFromServer(endpoint, accessToken);

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
              albumId = await createAlbum(endpoint, accessToken, localAlbum);
            }

            if (albumId) {
              await addAssetsToAlbum(
                endpoint,
                accessToken,
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
            albumId = await createAlbum(endpoint, accessToken, createAlbums);
          }

          await addAssetsToAlbum(
            endpoint,
            accessToken,
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
  accessToken: string,
  asset: any,
  deviceId: string,
  fromGoogleTakeout: boolean,
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
      } catch (e) {}
    }

    const createdAt =
      exifData && exifData.DateTimeOriginal != null
        ? new Date(exifData.DateTimeOriginal).toISOString()
        : (fromGoogleTakeout && getTakeoutTimestamp(asset.filePath)) ||
          fileStat.mtime.toISOString();

    const data = new FormData();
    data.append("deviceAssetId", asset.id);
    data.append("deviceId", deviceId);
    data.append("assetType", assetType);
    data.append("createdAt", createdAt);
    data.append("modifiedAt", fileStat.mtime.toISOString());
    data.append("isFavorite", JSON.stringify(false));
    data.append("fileExtension", path.extname(asset.filePath));
    data.append("duration", "0:00:00.000000");

    data.append("assetData", fs.createReadStream(asset.filePath));

    const config: AxiosRequestConfig<any> = {
      method: "post",
      maxRedirects: 0,
      url: `${endpoint}/asset/upload`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
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

function loadFirstJSON(paths: string[]) {
  while(paths.length > 0) {
    try {
      const path = paths.shift();
      if (path) {
        return require(path);
      }
    } catch (e) {
    }
  }
  // None of the files found.
  return null;
}

function getTakeoutTimestamp(filepath: string) {
  const regex = /^(?<main>.*?)(?<inc>\(\d+\))?(?<ext>\.[a-zA-Z0-9]*)$/;

  const match = regex.exec(filepath);
  if(!match || !match.groups) {
    log(chalk.red(`\nRegex match failed for ${filepath}`));
    return null;
  }

  const { main, inc = '', ext } = match.groups;
  const paths = [
    `${main}${inc}${ext}.json`,   // file(1).jpg => file(1).jpg.json
    `${main}${inc}.json`,         // file(1).jpg => file(1).json
    `${main}${ext}${inc}.json`,   // file(1).jpg => file.jpg(1).json
  ];

  const data = loadFirstJSON(paths);
  if (!data) {
    log(chalk.yellow(`\nError getting Google Takeout timestamp from ${filepath}`));
    return null;
  }

  const ts = data.photoTakenTime?.timestamp || data.creationTime.timestamp;
  return new Date(ts * 1000).toISOString();
}

async function getAlbumsFromServer(endpoint: string, accessToken: string) {
  try {
    const res = await axios.get(`${endpoint}/album`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data;
  } catch (e) {
    log(chalk.red("Error getting albums"), e);
    process.exit(1);
  }
}

async function createAlbum(
  endpoint: string,
  accessToken: string,
  albumName: string
) {
  try {
    const res = await axios.post(
      `${endpoint}/album`,
      { albumName },
      {
        headers: { Authorization: `Bearer ${accessToken} ` },
      }
    );
    return res.data.id;
  } catch (e) {
    log(chalk.red(`Error creating album '${albumName}'`), e);
  }
}

async function addAssetsToAlbum(
  endpoint: string,
  accessToken: string,
  albumId: string,
  assetIds: string[]
) {
  try {
    await axios.put(
      `${endpoint}/album/${albumId}/assets`,
      { assetIds: [...new Set(assetIds)] },
      {
        headers: { Authorization: `Bearer ${accessToken} ` },
      }
    );
  } catch (e) {
    log(chalk.red("Error adding asset to album"), e);
  }
}

async function getAssetInfoFromServer(
  endpoint: string,
  accessToken: string,
  deviceId: string
) {
  try {
    const res = await axios.get(`${endpoint}/asset/${deviceId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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

async function login(endpoint: string, email: string, password: string) {
  try {
    const res = await axios.post(`${endpoint}/auth/login`, {
      email,
      password,
    });

    if (res.status == 201) {
      log(chalk.green("Login status: OK"));
      return res.data;
    }
  } catch (e) {
    log(chalk.red("Error logging in - check email and password"));
    process.exit(1);
  }
}

function getAssetType(filePath: string) {
  const mimeType = mime.lookup(filePath) as string;

  return mimeType.split("/")[0].toUpperCase();
}

// node bin/index.js upload --email testuser@email.com --password password --server http://10.1.15.216:2283/api -d /Users/alex/Documents/immich-cli-upload-test-location
// node bin/index.js upload --help
