import React, { useRef, useState, useEffect } from 'react';
import './AddTag.scss';
import BottomNavbar from './../../components/bottom-navbar/BottomNavbar';
import axios from 'axios';
import { getDateTime, formatTimeStr } from './../../utils/date';
import { getTagInfoObjById } from './../events/eventUtils';

/**
 * Brief explanation how this works it's kind of confusing since everything is a callback of a callback
 * The bottomNavbar starts it off by setting loadCamera to true
 * Then that clicks on fileInput which if a device has a camera prompts to open the camera or show file upload(pc)
 * Then when the fileInput changes, cameraCallback is called and the previewPhoto function is called
 * That actually renders it on page, then when the rendered image load, it has a callback to update image meta eg. width/height
 * which can only be taken from a loaded <img />
 * I'm going to resize the photo with canvas for the thumbnail and potentially save storage by capping files
 * @param {*} props 
 */

// bad quick hack
let eventId = null;

// create function which returns resolved promise
// with data:base64 string
function getBase64(file) {
    const reader = new FileReader();

    return new Promise(resolve => {
        reader.onload = ev => {
            resolve(ev.target.result);
        };

        reader.readAsDataURL(file);
    });
}

// Taken from here: https://stackoverflow.com/a/54559514/3341620
async function fileListToBase64(fileList) {
    // here will be array of promisified functions
    const promises = [];

    // loop through fileList with for loop
    for (let i = 0, len = fileList.length; i < len; i++) {
        promises.push(getBase64(fileList[i]));
    }

    // array with base64 strings
    return await Promise.all(promises);
}

const AddTag = (props) => {
    const fileInput = useRef(null);
    const [loadCamera, triggerLoadCamera] = useState(false);
    const [fileUpload, triggerFileUpload] = useState(false);
    const [loadedPhotos, setLoadedPhotos] = useState([]);
    const [savingToDevice, setSavingToDevice] = useState(false);
    const [uploadInProgress, setUploadInProgress] = useState(false);

    // https://hacks.mozilla.org/2011/01/how-to-develop-a-html5-image-uploader/
    const scaleImage = (resolve, img) => {
        // figure out canvas height based on desired resize dimensions
        let newImageWidth = 300;
        let newImageHeight = 300;

        if (img.width / img.height >= 1) {
            newImageHeight = ((newImageWidth * img.height) / img.width); // round?
        } else {
            newImageWidth = ((newImageHeight * img.width) / img.height); // round?
        }
        
        const canvas = document.createElement("canvas");
        canvas.id = "resize-canvas";
        const ctx = canvas.getContext("2d");
        canvas.width = newImageWidth;
        canvas.height = newImageHeight;
        ctx.drawImage(img, 0, 0, newImageWidth, newImageHeight);
        resolve(canvas.toDataURL("image/png"));
        // fail case?
    }

    const createThumbnailSrc = (src) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.src = src;

            img.onload = () => {
                if (img.width <= 300) {
                    resolve(src);
                }
                scaleImage(resolve, img);
            };

            img.onerror = (err) => {
                reject(err);
            }
        });
    }

    const saveToDevice = async () => {
        setSavingToDevice(true);

        const offlineStorage = props.offlineStorage;
        const address = props.location.state;     

        // not going to add duplicate logic here because you can delete them somewhere else
        // the loaded photos are deleted after upload so duplicate issue doesn't happen unless the file is selected again
        for (let i = 0; i < loadedPhotos.length; i++) {
            const loadedPhoto = loadedPhotos[i];
            const index = i;
            const thumbnailSrc = await createThumbnailSrc(loadedPhoto.src);
            const oldCanvas = document.getElementById('resize-canvas');
            if (oldCanvas) {
                oldCanvas.remove();
            }

            offlineStorage.transaction('rw', offlineStorage.tags, async () => {
                if (
                    await offlineStorage.tags.add({
                        eventId,
                        addressId: address.addressId,
                        fileName: loadedPhoto.meta.name,
                        src: loadedPhoto.src,
                        thumbnail_src: thumbnailSrc,
                        meta: loadedPhoto.meta,
                        datetime: formatTimeStr(getDateTime()) // makes YYYY-MM-DD HH:MM:SS format for MySQL DateTime
                    }).then((insertedId) => {
                        return true;
                    })
                ) {
                    if (index === loadedPhotos.length - 1) {
                        alert('Photos saved');
                        setLoadedPhotos([]);
                        setSavingToDevice(false);
                    }
                } else {
                    alert('Failed to save photos to device');
                }
            })
            .catch(e => {
                console.log('failed to save photos', e);
                alert('Failed to save photos to device');
            });
        }
    }

    const uploadImages = () => {
        const baseApiPath = window.location.href.indexOf('localhost') !== -1
            ? process.env.REACT_APP_API_BASE_LOCAL
            : process.env.REACT_APP_API_BASE;
        const postUrl = baseApiPath + '/upload-tag';
        
        axios.post(postUrl, {
            headers: { Authorization: `Bearer ${props.token}` },
            images: loadedPhotos
        }).then((res) => {
            if (res.status === 200) {
                saveToDevice(); // because don't want to bridge remote sync from upload here
            } else {
                if (res.status === 403) {
                    alert("Your session has expired, please login again");
                    window.location.href = "/login"; // flush app state
                } else {
                    alert('Failed to upload');
                }
            }
            triggerFileUpload(false);
            setUploadInProgress(false);
        })
        .catch((err) => {
            if (typeof err.response !== "undefined" && typeof err.response.status !== "undefined" && err.response.status === 403) {
                alert('You have been logged out, please log back in to upload.');
                window.location.href = "/login"; // flush app state
            } else {
                console.log('upload err', err);
                triggerFileUpload(false);
                setUploadInProgress(false);
            }
        });
    }

    // Step 2: when file input changes, check if file/photo selected
    const cameraCallback = (fileInput) => {
        if (fileInput.files.length) {
			previewPhotos(fileInput);
		} else {
            alert('No image selected');
        }
    }

    // Step 3: read the photo and get src plus other data like size
    const previewPhotos = async (fileInput) => {
        const files = fileInput.files; // I guess multi-select upload is special, I tried it doesn't work with current code
        const filesLength = files.length;

        const base64s = await fileListToBase64(files);

        const newLoadedPhotos = [];

        const maxFileSize = 16_000_000;

        for (let i = 0; i < filesLength; i++) {
            const currentFile = files[i];

            if (currentFile.size >= maxFileSize) {
                alert("Selected file \"" + currentFile.name + "\" is too large, must be smaller than 16mb");
                continue;
            }

            newLoadedPhotos.push({
                addressId: props.location.state.addressId,
                fileName: currentFile.name,
                src: base64s[i],
                thumbanil_src: "",
                meta: {
                    name: currentFile.name,
                    size: currentFile.size
                }
            });
        }

        setLoadedPhotos(loadedPhotos.concat(newLoadedPhotos));
    }

    // Step 4: this runs anytime the page loads but when photos are available they will get rendered as <img />
    const renderPhotoPreviews = () => {
        return loadedPhotos.map((loadedPhoto, index) => {
            return (
                <div style={{
                    backgroundImage: 'url(' + loadedPhoto.src + ')'
                }} key={index} className="tagging-tracker__address-tag" >
                    <img alt={ loadedPhoto.meta.name } src={loadedPhoto.src} onLoad={ (e) => setLoadedImageMeta(e.target, index) } />
                </div>
            )
        })
    }

    // Step 5: this is a callback when the new <img />'s load to get additional meta
    // the meta's collected in different stages, the file itself(previewPhoto) has the name, size
    // the image that loads has the width/height
    const setLoadedImageMeta = (loadedImage, loopIndex) => {
        const loadedPhotosClone = loadedPhotos;
		loadedPhotos.filter((loadedPhoto, index) => { // eslint-disable-line
            if (loopIndex === index && typeof loadedPhotos[index].meta.width === "undefined") {
                loadedPhotosClone[index].meta['width'] = loadedImage.width;
                loadedPhotosClone[index].meta['height'] = loadedImage.height;
                setLoadedPhotos(loadedPhotosClone);
            }
        });
    }

    const getEventId = async ( offlineStorage, tagInfoId ) => {
        const tagInfoObj = await getTagInfoObjById(offlineStorage, tagInfoId);
        eventId = tagInfoObj ? tagInfoObj.eventId : null;
    }

    // set eventId so tags are saved against that in new structure not just saved under address
    useEffect(() => {
        if (props.offlineStorage && props.location.state.tagInfoId) {
            getEventId(props.offlineStorage, props.location.state.tagInfoId);
        }
    }, [props.location.state.tagInfoId, props.offlineStorage]);

    // Step 1: Click on file input when clicking on Use Camera button
    useEffect(() => {
        if (loadCamera) {
            // handled in BottomNavbar directly
        } else {
            triggerLoadCamera(false);
        }
    }, [loadCamera]);

    // callback to toggle/make Use Camera useable again
    useEffect(() => {
        triggerLoadCamera(false);
    }, [loadedPhotos]);

    useEffect(() => {
        if (fileUpload && !uploadInProgress) {
            setUploadInProgress(true);
            uploadImages();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fileUpload, uploadInProgress]); // TODO ugly fix above, eslint disable but not trying to put the upload code in here

    // TODO this is not staying eg. ugly flash
    useEffect(() => {
        props.setBodyClass("tagging-tracker__body increase-height");
    }, [props]);

    return (
        <>
            <div className="tagging-tracker__add-tag move-bottom-navbar-down">
                <input type="file" ref={fileInput} name="image" onChange={ () => { cameraCallback(fileInput.current) } } id="add-tag-file-input" multiple />
                { renderPhotoPreviews() }
            </div>
            <BottomNavbar
                {...props}
                triggerLoadCamera={triggerLoadCamera}
                loadCamera={loadCamera}
                triggerFileUpload={triggerFileUpload}
                fileUpload={fileUpload}
                saveToDevice={saveToDevice}
                savingToDevice={savingToDevice}
                uploadInProgress={uploadInProgress}
                setUploadInProgress={setUploadInProgress}
                loadedPhotos={loadedPhotos}
                appOnline={props.appOnline}
                token={props.token}
            />
        </>
    );
}

export default AddTag;