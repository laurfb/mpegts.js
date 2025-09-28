// Adding extraction of color_primaries, color_transfer, color_space, and pix_fmt metadata

function extractColorMetadata(data) {
    const colorPrimaries = data.color_primaries;
    const colorTransfer = data.color_transfer;
    const colorSpace = data.color_space;
    const pixFmt = data.pix_fmt;

    return {
        colorPrimaries,
        colorTransfer,
        colorSpace,
        pixFmt,
    };
}

// Example usage of the extractColorMetadata function
const videoData = {
    color_primaries: 'bt709',
    color_transfer: 'bt709',
    color_space: 'bt709',
    pix_fmt: 'yuv420p',
};

const colorMetadata = extractColorMetadata(videoData);
console.log(colorMetadata);