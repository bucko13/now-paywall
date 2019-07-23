module.exports = (req, res) => {
  return res
    .status(200)
    .json({
      message: 'This message is behind the paywall and it appears you paid!',
    })
}
